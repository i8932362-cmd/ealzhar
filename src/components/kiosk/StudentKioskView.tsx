import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import confetti from 'canvas-confetti';
import {
  Camera,
  QrCode,
  CheckCircle2,
  AlertCircle,
  Clock,
  Users,
  Search,
  ShieldCheck,
  RotateCcw,
  Volume2,
  VolumeX,
  ArrowLeft,
  Loader2,
  UserCheck,
  Check,
  Timer,
  AlertTriangle,
} from 'lucide-react';
import { Student, SchoolClass, ToiletPermit, FrequentToiletStudent, AttendanceSession } from '../../types/index.ts';
import { useSync } from '../../context/SyncContext.tsx';
import { queueStudentScanBatch, postWithOfflineFallback } from '../../lib/api.ts';
import { formatWibTime24, getNextUpcomingSessionForType, sortSessions } from '../../lib/sessions.ts';
import { CameraPreviewStage } from '../common/CameraPreviewStage.tsx';
import {
  loadFaceDetectionModels,
  areFaceModelsLoaded,
  acquireCameraStream,
  attachStreamToVideo,
  stopMediaStreamSafely,
  attachCameraResumeListeners,
  detectFacesInVideo,
  findBestFaceMatch,
  parseCameraError,
} from '../../lib/faceDetection.ts';
import { useHardwareBarcodeScanner } from '../../lib/barcodeListener.ts';
import {
  playSuccessChime,
  playErrorBeep,
  playWarningTone,
  playScanClick,
  speakIndonesian,
} from '../../lib/soundEffects.ts';

export interface StudentKioskViewProps {
  onReturnToPortal?: () => void;
}

function getPermitStartMs(permit: ToiletPermit): number {
  if (permit.createdAt) {
    const parsed = Date.parse(permit.createdAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (permit.date && permit.timeOut) {
    const normalizedTime = permit.timeOut.length === 5 ? `${permit.timeOut}:00` : permit.timeOut;
    const parsed = Date.parse(`${permit.date}T${normalizedTime}+07:00`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function formatCountdown(totalSec: number): string {
  const abs = Math.abs(totalSec);
  const mins = Math.floor(abs / 60);
  const secs = abs % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return totalSec < 0 ? `-${mm}:${ss}` : `${mm}:${ss}`;
}

function computePermitCountdown(
  permit: ToiletPermit,
  babMinutes: number,
  bakMinutes: number,
  otherMinutes: number,
  nowMs: number
) {
  const rawType = String(permit.toiletType || '').toUpperCase();
  const type: 'BAB' | 'BAK' | 'LAINNYA' =
    rawType === 'BAB' ? 'BAB' : rawType === 'LAINNYA' || rawType === 'OTHER' ? 'LAINNYA' : 'BAK';
  const limitMinutes =
    permit.durationLimitMinutes ||
    (type === 'BAB' ? babMinutes : type === 'BAK' ? bakMinutes : otherMinutes);
  const startMs = getPermitStartMs(permit);
  const elapsedSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const remainingSec = limitMinutes * 60 - elapsedSec;
  return {
    type,
    typeLabel: type === 'LAINNYA' ? 'Izin Lainnya' : type,
    limitMinutes,
    remainingSec,
    isExpired: remainingSec < 0,
    isWarning: remainingSec >= 0 && remainingSec <= 60,
    formatted: formatCountdown(remainingSec),
  };
}

export const StudentKioskView: React.FC<StudentKioskViewProps> = ({ onReturnToPortal }) => {
  const {
    settings,
    todayAttendance,
    activePermits,
    frequentToiletStudents,
    faceTemplates,
    students,
    classes,
    sessions,
    activeStudentSession,
    wibNowHhMm,
    notifyFaceDatabaseChanged,
  } = useSync();

  const studentSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.targetType === 'student')),
    [sessions]
  );

  const nextStudentSession = useMemo(
    () => (activeStudentSession ? null : getNextUpcomingSessionForType(sessions, 'student', wibNowHhMm)),
    [sessions, activeStudentSession, wibNowHhMm]
  );

  const sessionTodayAttendance = useMemo(() => {
    if (!activeStudentSession) return [];
    return todayAttendance.filter(
      (a) => !a.sessionId || String(a.sessionId) === String(activeStudentSession.id)
    );
  }, [todayAttendance, activeStudentSession]);

  const babMinutes = settings?.toiletBabMinutes ?? 10;
  const bakMinutes = settings?.toiletBakMinutes ?? 5;
  const otherMinutes = settings?.toiletMaxMinutes ?? 10;

  // Camera & AI states (no blocking loading spinner when opening camera)
  const [isCameraActive, setIsCameraActive] = useState<boolean>(true);
  const [isRequestingCamera, setIsRequestingCamera] = useState<boolean>(true);
  const [videoAspect, setVideoAspect] = useState<number>(4 / 3);
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(() =>
    areFaceModelsLoaded() ? 'ready' : 'idle'
  );
  const [cameraError, setCameraError] = useState<{ title: string; message: string } | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [mirrorPreview, setMirrorPreview] = useState<boolean>(true);
  const [needsPlayTap, setNeedsPlayTap] = useState<boolean>(false);
  const mirrorPreviewRef = useRef<boolean>(true);
  mirrorPreviewRef.current = mirrorPreview;
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [returningPermitId, setReturningPermitId] = useState<string | null>(null);

  // Video & Canvas refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const isDetectingRef = useRef<boolean>(false);
  const lastDetectTimeRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);
  const cameraExpectedActiveRef = useRef<boolean>(true);
  const facingModeRef = useRef<'user' | 'environment'>('user');
  facingModeRef.current = facingMode;

  // Auto-submit scan refs & deduplication
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const manualDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSubmittedScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const alertedExpiredIdsRef = useRef<Set<string>>(new Set());

  const studentFaceTemplates = useMemo(() => {
    return faceTemplates.filter(
      (f) => (!f.personType || f.personType === 'student') && Array.isArray(f.descriptor) && f.descriptor.length > 0
    );
  }, [faceTemplates]);

  const [detectedStudentsInFrame, setDetectedStudentsInFrame] = useState<
    Array<{ student: Student; distance: number }>
  >([]);
  const [hasFaceInFrame, setHasFaceInFrame] = useState<boolean>(false);

  const [manualCardInput, setManualCardInput] = useState('');
  const [statusFeedback, setStatusFeedback] = useState<{
    type: 'success' | 'error' | 'warning' | 'pending';
    title: string;
    message: string;
  } | null>(null);

  const [showManualModal, setShowManualModal] = useState(false);
  const [showToiletModal, setShowToiletModal] = useState(false);

  // Real-time Clock & 1-second Countdown Ticker
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [currentTime, setCurrentTime] = useState<string>('');
  const [currentDate, setCurrentDate] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setNowMs(now.getTime());
      setCurrentTime(formatWibTime24(now, true));
      setCurrentDate(
        now.toLocaleDateString('id-ID', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      );
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Alert once via tone + TTS when a student's toilet/leave timer expires
  useEffect(() => {
    if (!soundEnabled || activePermits.length === 0) return;
    for (const permit of activePermits) {
      const countdown = computePermitCountdown(permit, babMinutes, bakMinutes, otherMinutes, nowMs);
      if (countdown.isExpired && !alertedExpiredIdsRef.current.has(permit.id)) {
        alertedExpiredIdsRef.current.add(permit.id);
        playWarningTone();
        speakIndonesian(
          `Perhatian, waktu izin keluar ${permit.studentName || 'siswa'} telah habis`
        );
        break;
      }
    }
  }, [activePermits, babMinutes, bakMinutes, otherMinutes, nowMs, soundEnabled]);

  // Keep refs synced immediately so detection loop matches against the latest face database
  const studentsRef = useRef<Student[]>([]);
  const classesRef = useRef<SchoolClass[]>([]);
  const faceTemplatesRef = useRef<Array<{ personId: string; descriptor: number[] }>>([]);
  studentsRef.current = students;
  classesRef.current = classes;
  faceTemplatesRef.current = studentFaceTemplates;

  useEffect(() => {
    mountedRef.current = true;
    if (areFaceModelsLoaded()) {
      setModelStatus('ready');
    } else {
      setModelStatus('loading');
      loadFaceDetectionModels()
        .then((ok) => {
          if (mountedRef.current) setModelStatus(ok ? 'ready' : 'error');
        })
        .catch(() => {
          if (mountedRef.current) setModelStatus('error');
        });
    }

    void startCamera();

    const detachResumeListeners = attachCameraResumeListeners({
      getStream: () => streamRef.current,
      getVideo: () => videoRef.current,
      isCameraExpectedActive: () => mountedRef.current && cameraExpectedActiveRef.current,
      onNeedRestart: () => {
        if (mountedRef.current && cameraExpectedActiveRef.current) {
          void startCamera(facingModeRef.current);
        }
      },
    });

    return () => {
      mountedRef.current = false;
      detachResumeListeners();
      stopCamera();
      if (manualDebounceRef.current) clearTimeout(manualDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isCameraActive || !streamRef.current || !videoRef.current) return;
    let cancelled = false;
    attachStreamToVideo(videoRef.current, streamRef.current).then((attachRes) => {
      if (!cancelled && mountedRef.current) {
        setNeedsPlayTap(attachRes.needsUserTapToPlay);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isCameraActive]);

  const startCamera = async (modeOverride?: 'user' | 'environment', fromUserGesture = false) => {
    const targetMode = modeOverride || facingMode;
    cameraExpectedActiveRef.current = true;
    setCameraError(null);
    setNeedsPlayTap(false);
    setIsCameraActive(true);
    setIsRequestingCamera(true);

    try {
      if (streamRef.current) {
        stopMediaStreamSafely(streamRef.current);
        streamRef.current = null;
      }

      if (!areFaceModelsLoaded()) {
        setModelStatus('loading');
        loadFaceDetectionModels()
          .then((ok) => setModelStatus(ok ? 'ready' : 'error'))
          .catch(() => setModelStatus('error'));
      } else {
        setModelStatus('ready');
      }

      const stream = await acquireCameraStream(targetMode, { fromUserGesture });
      if (!mountedRef.current || !cameraExpectedActiveRef.current) {
        stopMediaStreamSafely(stream);
        return;
      }
      streamRef.current = stream;

      if (videoRef.current) {
        const attachRes = await attachStreamToVideo(videoRef.current, stream);
        if (!mountedRef.current || !cameraExpectedActiveRef.current) {
          stopMediaStreamSafely(stream);
          return;
        }
        setNeedsPlayTap(attachRes.needsUserTapToPlay);
        if (videoRef.current.videoWidth > 0 && videoRef.current.videoHeight > 0) {
          setVideoAspect(videoRef.current.videoWidth / videoRef.current.videoHeight);
        }
      }

      if (!mountedRef.current) return;
      setIsRequestingCamera(false);
      setIsCameraActive(true);
      startDetectionLoop();
    } catch (err: any) {
      if (!mountedRef.current || err?.message === 'Camera request superseded') return;
      cameraExpectedActiveRef.current = false;
      setIsRequestingCamera(false);
      setIsCameraActive(false);
      setNeedsPlayTap(false);
      setCameraError(parseCameraError(err));
    }
  };

  const stopCamera = () => {
    cameraExpectedActiveRef.current = false;
    if (streamRef.current) {
      stopMediaStreamSafely(streamRef.current);
      streamRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setIsRequestingCamera(false);
    setIsCameraActive(false);
    setNeedsPlayTap(false);
    setDetectedStudentsInFrame([]);
    setHasFaceInFrame(false);
  };

  const switchCamera = () => {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    setMirrorPreview(nextMode === 'user');
    if (isCameraActive) {
      void startCamera(nextMode, true);
    }
  };

  const startDetectionLoop = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    const runFrame = () => {
      if (!videoRef.current || !canvasRef.current || videoRef.current.paused || videoRef.current.ended) {
        animFrameRef.current = requestAnimationFrame(runFrame);
        return;
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const now = performance.now();

      if (video.videoWidth > 0 && video.videoHeight > 0) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }

        if (areFaceModelsLoaded() && !isDetectingRef.current && now - lastDetectTimeRef.current >= 120) {
          isDetectingRef.current = true;
          lastDetectTimeRef.current = now;

          detectFacesInVideo(video)
            .then((detections) => {
              if (!mountedRef.current || !streamRef.current) return;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                const recognizedStudents: Array<{ student: Student; distance: number }> = [];
                const currentTemplates = faceTemplatesRef.current;
                const currentStudents = studentsRef.current;
                const currentClasses = classesRef.current;

                if (detections.length > 0) {
                  setHasFaceInFrame(true);

                  detections.forEach((det) => {
                    const { box, descriptor } = det;
                    const match = findBestFaceMatch(descriptor, currentTemplates);

                    let studentName = 'Wajah Belum Terdaftar';
                    let className = '';
                    let isMatched = false;
                    let confidencePct = 0;

                    if (match && match.isMatch) {
                      const foundStudent = currentStudents.find((s) => s.id === match.personId && s.isActive);
                      if (foundStudent) {
                        studentName = foundStudent.name;
                        const cls = currentClasses.find((c) => c.id === foundStudent.classId);
                        className = cls ? cls.name : '';
                        isMatched = true;
                        confidencePct = Math.max(50, Math.min(99, Math.round((1 - match.distance) * 100)));
                        recognizedStudents.push({ student: foundStudent, distance: match.distance });
                      }
                    }

                    const strokeColor = isMatched ? '#10b981' : '#f59e0b';
                    const drawX = mirrorPreviewRef.current
                      ? Math.max(0, canvas.width - (box.x + box.width))
                      : box.x;

                    ctx.save();
                    // Subtle full bounding box aligned to face database coordinates
                    ctx.lineWidth = 2.5;
                    ctx.strokeStyle = strokeColor;
                    ctx.strokeRect(drawX, box.y, box.width, box.height);

                    // Crisp glowing corner brackets
                    const corner = Math.max(14, Math.min(26, Math.min(box.width, box.height) * 0.25));
                    ctx.lineWidth = 4.5;
                    ctx.beginPath();
                    // Top-left
                    ctx.moveTo(drawX, box.y + corner); ctx.lineTo(drawX, box.y); ctx.lineTo(drawX + corner, box.y);
                    // Top-right
                    ctx.moveTo(drawX + box.width - corner, box.y); ctx.lineTo(drawX + box.width, box.y); ctx.lineTo(drawX + box.width, box.y + corner);
                    // Bottom-left
                    ctx.moveTo(drawX, box.y + box.height - corner); ctx.lineTo(drawX, box.y + box.height); ctx.lineTo(drawX + corner, box.y + box.height);
                    // Bottom-right
                    ctx.moveTo(drawX + box.width - corner, box.y + box.height); ctx.lineTo(drawX + box.width, box.y + box.height); ctx.lineTo(drawX + box.width, box.y + box.height - corner);
                    ctx.stroke();

                    const baseLabel = className ? `${studentName} (${className})` : studentName;
                    const label = isMatched ? `✓ ${baseLabel} • ${confidencePct}%` : baseLabel;
                    ctx.font = 'bold 14px Inter, sans-serif';
                    const textWidth = ctx.measureText(label).width;
                    const pillW = textWidth + 20;
                    const pillX = Math.max(4, Math.min(canvas.width - pillW - 4, drawX));
                    const pillY = box.y > 32 ? box.y - 32 : box.y + box.height + 4;

                    ctx.fillStyle = isMatched ? 'rgba(5, 150, 105, 0.92)' : 'rgba(217, 119, 6, 0.92)';
                    ctx.fillRect(pillX, pillY, pillW, 28);

                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(label, pillX + 10, pillY + 19);
                    ctx.restore();
                  });
                } else {
                  setHasFaceInFrame(false);
                }

                setDetectedStudentsInFrame(recognizedStudents);
              }
            })
            .catch((err) => {
              console.debug('Face detection cycle error:', err);
            })
            .finally(() => {
              isDetectingRef.current = false;
            });
        }
      }

      animFrameRef.current = requestAnimationFrame(runFrame);
    };

    animFrameRef.current = requestAnimationFrame(runFrame);
  };

  // Enqueue student attendance into 3-second batch (no photos stored) + TTS
  const submitStudentAttendance = useCallback(
    async (matchedStudent: Student, code: string, method: 'FACE_SCAN' | 'BARCODE_SCAN') => {
      if (!activeStudentSession) {
        if (soundEnabled) {
          playErrorBeep();
          speakIndonesian('Di luar jam sesi presensi siswa yang aktif');
        }
        setStatusFeedback({
          type: 'error',
          title: 'Di Luar Jadwal Sesi Presensi Siswa',
          message: nextStudentSession
            ? `Sekarang pukul ${wibNowHhMm} WIB. Sesi berikutnya (${nextStudentSession.name}) dibuka otomatis pukul ${nextStudentSession.startTime}–${nextStudentSession.endTime} WIB.`
            : `Sekarang pukul ${wibNowHhMm} WIB. Tidak ada sesi presensi siswa yang aktif saat ini.`,
        });
        return;
      }

      const alreadyRecorded = sessionTodayAttendance.find((a) => a.studentId === matchedStudent.id);
      if (alreadyRecorded) {
        if (soundEnabled) {
          playErrorBeep();
          speakIndonesian(`Presensi ganda ditolak, ${matchedStudent.name} sudah presensi pada sesi ini`);
        }
        setStatusFeedback({
          type: 'error',
          title: 'Presensi Ganda Ditolak',
          message: `${matchedStudent.name} sudah presensi di sesi ${activeStudentSession.name} (${alreadyRecorded.timeIn} WIB - ${alreadyRecorded.status}).`,
        });
        return;
      }

      setStatusFeedback({
        type: 'pending',
        title: `Memproses Presensi (${activeStudentSession.name})...`,
        message: `${matchedStudent.name} masuk antrian batch (terkirim otomatis maks 3 detik).`,
      });

      try {
        const res = await queueStudentScanBatch({
          studentId: matchedStudent.id,
          barcodeCard: code,
          method,
          sessionId: activeStudentSession.id,
        });

        if (res.offline) {
          if (soundEnabled) {
            playWarningTone();
            speakIndonesian(`${matchedStudent.name}, presensi disimpan di mode offline`);
          }
          setStatusFeedback({
            type: 'warning',
            title: 'Tersimpan di Mode Offline',
            message: `${matchedStudent.name}: ${res.message || 'Otomatis dikirim ke Google Sheets saat online.'}`,
          });
          return;
        }

        if (res.success && (res.attendance || res.deduped)) {
          const isLate = res.attendance?.status === 'Terlambat';
          if (soundEnabled) {
            playSuccessChime();
            speakIndonesian(
              `${matchedStudent.name}, presensi ${activeStudentSession.name} berhasil, ${isLate ? 'status terlambat' : 'hadir tepat waktu'}`
            );
          }
          confetti({
            particleCount: 70,
            spread: 65,
            origin: { y: 0.6 },
          });

          setStatusFeedback({
            type: 'success',
            title: isLate ? `Presensi Terlambat (${activeStudentSession.name})` : `Presensi Berhasil (${activeStudentSession.name})`,
            message: res.attendance
              ? `${matchedStudent.name} (${res.attendance.timeIn} WIB) - Status: ${res.attendance.status}`
              : res.message || `${matchedStudent.name} berhasil presensi.`,
          });

          void notifyFaceDatabaseChanged();
        } else {
          if (soundEnabled) {
            playErrorBeep();
            speakIndonesian(
              res.duplicate
                ? `Presensi ganda ditolak, ${matchedStudent.name} sudah presensi pada sesi ini`
                : `Presensi ${matchedStudent.name} ditolak`
            );
          }
          setStatusFeedback({
            type: 'error',
            title: res.duplicate ? 'Presensi Ganda Ditolak' : 'Presensi Ditolak',
            message: res.error || 'Gagal merekam presensi.',
          });
        }
      } catch (err: any) {
        if (soundEnabled) {
          playErrorBeep();
          speakIndonesian(`Presensi ${matchedStudent.name} gagal diproses`);
        }
        setStatusFeedback({
          type: 'error',
          title: 'Presensi Gagal',
          message: err?.message || 'Terjadi kesalahan saat menyimpan ke Google Sheets.',
        });
      }
    },
    [activeStudentSession, nextStudentSession, wibNowHhMm, sessionTodayAttendance, soundEnabled, notifyFaceDatabaseChanged]
  );

  // Process Card/RFID/Barcode Scan with strict biometric verification & deduplication
  const handleScanCard = useCallback(
    async (scannedCode: string) => {
      const code = scannedCode.trim();
      if (!code) return;

      const now = Date.now();
      if (
        lastSubmittedScanRef.current.code.toLowerCase() === code.toLowerCase() &&
        now - lastSubmittedScanRef.current.at < 1500
      ) {
        return;
      }
      lastSubmittedScanRef.current = { code, at: now };

      if (manualDebounceRef.current) {
        clearTimeout(manualDebounceRef.current);
        manualDebounceRef.current = null;
      }
      setManualCardInput('');

      playScanClick();

      const matchedStudent = students.find(
        (s) =>
          s.isActive &&
          (s.barcodeCard.toLowerCase() === code.toLowerCase() || s.nis.toLowerCase() === code.toLowerCase())
      );

      if (!matchedStudent) {
        if (soundEnabled) {
          playErrorBeep();
          speakIndonesian('Kartu atau nomor induk tidak dikenali');
        }
        setStatusFeedback({
          type: 'error',
          title: 'Kartu Tidak Dikenali',
          message: `Kode "${code}" tidak terdaftar pada siswa aktif manapun.`,
        });
        return;
      }

      // Strict face verification against FaceTemplates database
      const studentHasTemplate = studentFaceTemplates.some((t) => t.personId === matchedStudent.id);
      if (studentHasTemplate) {
        if (!isCameraActive) {
          if (soundEnabled) {
            playErrorBeep();
            speakIndonesian('Kamera wajib aktif untuk mencocokkan wajah siswa');
          }
          setStatusFeedback({
            type: 'error',
            title: 'Kamera Wajib Aktif',
            message: `Wajah ${matchedStudent.name} terdaftar di database biometrik. Aktifkan kamera untuk mencocokkan wajah.`,
          });
          return;
        }

        const studentFacePresent = detectedStudentsInFrame.some((d) => d.student.id === matchedStudent.id);
        if (!studentFacePresent) {
          if (soundEnabled) {
            playErrorBeep();
            speakIndonesian(
              hasFaceInFrame
                ? `Wajah tidak cocok dengan data ${matchedStudent.name}`
                : `Wajah ${matchedStudent.name} belum terlihat di depan kamera`
            );
          }
          setStatusFeedback({
            type: 'error',
            title: 'Wajah Tidak Cocok dengan Database',
            message: hasFaceInFrame
              ? `Wajah di kamera tidak cocok dengan data wajah milik ${matchedStudent.name}. Presensi ditolak.`
              : `Wajah ${matchedStudent.name} belum terdeteksi di depan kamera. Hadapkan wajah ke kamera lalu scan ulang.`,
          });
          return;
        }
      }

      await submitStudentAttendance(matchedStudent, code, studentHasTemplate ? 'FACE_SCAN' : 'BARCODE_SCAN');
    },
    [
      students,
      studentFaceTemplates,
      isCameraActive,
      detectedStudentsInFrame,
      hasFaceInFrame,
      soundEnabled,
      submitStudentAttendance,
    ]
  );

  // Automatic submit when typing/scanning/pasting into the Scan/RFID input box
  const handleScannerInputChange = (val: string) => {
    setManualCardInput(val);
    if (manualDebounceRef.current) {
      clearTimeout(manualDebounceRef.current);
      manualDebounceRef.current = null;
    }

    const trimmed = val.trim();
    if (!trimmed) return;

    const clean = trimmed.toLowerCase();
    const directMatch = students.some(
      (s) => s.isActive && (s.barcodeCard.toLowerCase() === clean || s.nis.toLowerCase() === clean)
    );
    if (directMatch) {
      void handleScanCard(trimmed);
      return;
    }

    if (trimmed.length >= 5) {
      manualDebounceRef.current = setTimeout(() => {
        void handleScanCard(trimmed);
      }, 450);
    }
  };

  useHardwareBarcodeScanner(handleScanCard, !showManualModal && !showToiletModal, {
    matchDirectly: (candidate: string) => {
      const clean = candidate.trim().toLowerCase();
      return students.some(
        (s) => s.isActive && (s.barcodeCard.toLowerCase() === clean || s.nis.toLowerCase() === clean)
      );
    },
    autoSubmitDelayMs: 80,
  });

  const handleConfirmToiletReturn = useCallback(
    async (permit: ToiletPermit) => {
      if (returningPermitId === permit.id) return;
      setReturningPermitId(permit.id);
      try {
        const res = await postWithOfflineFallback('toiletReturn', { permitId: permit.id });
        if (res.success) {
          if (res.exceeded) {
            if (soundEnabled) {
              playWarningTone();
              speakIndonesian(`${permit.studentName || 'Siswa'} telah kembali ke kelas, waktu melebihi batas`);
            }
          } else {
            if (soundEnabled) {
              playSuccessChime();
              speakIndonesian(`${permit.studentName || 'Siswa'} telah kembali ke kelas`);
            }
          }
          void notifyFaceDatabaseChanged();
        }
      } finally {
        setReturningPermitId(null);
      }
    },
    [returningPermitId, soundEnabled, notifyFaceDatabaseChanged]
  );

  useEffect(() => {
    if (statusFeedback && statusFeedback.type !== 'pending') {
      const timer = setTimeout(() => {
        setStatusFeedback(null);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [statusFeedback]);

  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-slate-50 dark:bg-slate-950 p-3 sm:p-6 lg:p-8">
      {/* Top Banner / Time Header */}
      <div className="max-w-7xl mx-auto mb-5 sm:mb-6 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 p-4 sm:p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-4">
          {onReturnToPortal && (
            <button
              onClick={onReturnToPortal}
              className="p-3 rounded-2xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition flex items-center gap-2 font-bold text-xs"
              title="Kembali ke Menu Pilihan Presensi"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Menu Pilihan</span>
            </button>
          )}
          <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-bold text-xl shadow-md shadow-blue-500/20">
            <QrCode className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
              {settings?.schoolName || 'Yayasan Mambaul Ulum'}
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
              {settings?.foundationAddress ? `${settings.foundationAddress} • ` : ''}Tahun Ajaran{' '}
              {settings?.academicYear} •{' '}
              {activeStudentSession
                ? `Sesi: ${activeStudentSession.name} (${activeStudentSession.startTime}–${activeStudentSession.endTime} WIB • Batas ${activeStudentSession.lateCutoffTime} WIB)`
                : nextStudentSession
                  ? `Sesi Berikutnya: ${nextStudentSession.name} (${nextStudentSession.startTime} WIB)`
                  : 'Menunggu Jadwal Sesi Siswa'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-right">
          <div className="p-3 bg-slate-100 dark:bg-slate-800 rounded-2xl">
            <div className="flex items-center justify-end gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400">
              <Clock className="w-3.5 h-3.5" />
              <span>{currentDate}</span>
            </div>
            <div className="text-2xl sm:text-3xl font-black font-mono tracking-tight text-slate-900 dark:text-white">
              {currentTime ? `${currentTime} WIB` : '--:--:--'}
            </div>
          </div>

          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="p-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 transition"
            title={soundEnabled ? 'Matikan Suara & Pembaca Status (TTS)' : 'Aktifkan Suara & Pembaca Status (TTS)'}
          >
            {soundEnabled ? <Volume2 className="w-5 h-5 text-emerald-500" /> : <VolumeX className="w-5 h-5 text-slate-400" />}
          </button>
        </div>
      </div>

      {/* Main Kiosk Layout: Centered Scan Box & Wide Symmetrical Camera Stage Above Monitoring Panels */}
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="max-w-6xl mx-auto space-y-5">
          {/* Active Session Auto-Switch Status Card (Strict 24-Hour WIB & Per-Session Sheet Isolation) */}
          {activeStudentSession ? (
            <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
                <div>
                  <div className="font-black text-emerald-900 dark:text-emerald-200">
                    Sesi Presensi Siswa Aktif: {activeStudentSession.name}
                  </div>
                  <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
                    Jam Sesi: <strong>{activeStudentSession.startTime}–{activeStudentSession.endTime} WIB</strong> • Batas Tepat Waktu: <strong>{activeStudentSession.lateCutoffTime} WIB</strong>
                  </div>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-lg bg-white/80 dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 font-mono text-[11px] font-bold text-emerald-800 dark:text-emerald-300">
                Sheet: {activeStudentSession.sheetName}
              </span>
            </div>
          ) : (
            <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5">
                <Clock className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <div>
                  <div className="font-black text-amber-900 dark:text-amber-200">
                    Di Luar Jadwal Sesi Presensi Siswa ({wibNowHhMm} WIB)
                  </div>
                  <div className="text-[11px] text-amber-700 dark:text-amber-300">
                    {nextStudentSession
                      ? `Sesi "${nextStudentSession.name}" otomatis aktif pukul ${nextStudentSession.startTime}–${nextStudentSession.endTime} WIB.`
                      : 'Belum ada sesi presensi siswa aktif. Admin dapat mengatur jadwal sesi di Menu Admin.'}
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* 1. Kotak Scan Kartu / RFID berada di ATAS Kamera Scan Siswa */}
          <div
            onClick={() => scanInputRef.current?.focus()}
            className="p-5 sm:p-6 rounded-3xl bg-gradient-to-r from-blue-600 to-indigo-700 text-white shadow-lg relative overflow-hidden cursor-text"
          >
            <div className="relative z-10 flex items-center justify-between gap-4">
              <div className="space-y-1">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-white/20 text-[11px] font-semibold uppercase tracking-wider">
                  <span>Kirim Otomatis • Batch 3 Detik • Suara TTS {soundEnabled ? 'Aktif' : 'Mati'}</span>
                </span>
                <h2 className="text-lg sm:text-2xl font-black tracking-tight">
                  Kotak Scan Kartu / RFID Siswa
                </h2>
                <p className="text-xs sm:text-sm text-blue-100">
                  Tempel kartu RFID atau ketik NIS — data presensi terkirim otomatis tanpa menekan Enter.
                </p>
              </div>
              <div className="w-14 h-14 rounded-2xl bg-white/10 backdrop-blur-md flex items-center justify-center flex-shrink-0">
                <QrCode className="w-7 h-7" />
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-white/15">
              <input
                ref={scanInputRef}
                id="scanner-trap-input"
                type="text"
                value={manualCardInput}
                onChange={(e) => handleScannerInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleScanCard(manualCardInput);
                  }
                }}
                placeholder="Tempelkan kartu RFID / Scan Barcode / Ketik NIS siswa (otomatis terkirim)..."
                className="w-full px-4 py-3 text-sm sm:text-base font-semibold rounded-2xl bg-white/15 border border-white/30 text-white placeholder-blue-100 focus:outline-none focus:ring-2 focus:ring-white"
              />
            </div>
          </div>

          {statusFeedback && (
            <div
              className={`p-4 sm:p-5 rounded-3xl border shadow-lg animate-in slide-in-from-top-4 duration-200 flex items-start gap-4 ${
                statusFeedback.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100'
                  : statusFeedback.type === 'error'
                  ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-900 dark:text-red-100'
                  : statusFeedback.type === 'pending'
                  ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-100'
                  : 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100'
              }`}
            >
              <div
                className={`p-2 rounded-xl flex-shrink-0 ${
                  statusFeedback.type === 'success'
                    ? 'bg-emerald-500 text-white'
                    : statusFeedback.type === 'error'
                    ? 'bg-red-500 text-white'
                    : statusFeedback.type === 'pending'
                    ? 'bg-blue-500 text-white'
                    : 'bg-amber-500 text-white'
                }`}
              >
                {statusFeedback.type === 'success' ? (
                  <CheckCircle2 className="w-6 h-6" />
                ) : statusFeedback.type === 'pending' ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  <AlertCircle className="w-6 h-6" />
                )}
              </div>
              <div className="flex-1">
                <h4 className="text-base font-bold">{statusFeedback.title}</h4>
                <p className="text-sm opacity-90 mt-0.5">{statusFeedback.message}</p>
              </div>
            </div>
          )}

          {/* 2. Wide Symmetrical Centered Non-Mirrored Camera View Card */}
          <div className="relative rounded-3xl overflow-hidden bg-slate-950 border border-slate-800 shadow-xl flex flex-col items-center justify-center">
            {isCameraActive && (
              <CameraPreviewStage
                videoRef={videoRef}
                canvasRef={canvasRef}
                isActive={isCameraActive}
                showGuideFrame
                mirrorPreview={mirrorPreview}
                needsPlayTap={needsPlayTap}
                onTapToPlay={() => {
                  void videoRef.current?.play().then(() => setNeedsPlayTap(false)).catch(() => {});
                }}
                maxHeightClass="h-[58dvh] min-h-[360px] max-h-[640px] sm:h-[500px] lg:h-[580px]"
                onVideoDimensions={(w, h) => setVideoAspect(w / h)}
              >
                {isRequestingCamera && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/75 backdrop-blur-xs p-5 text-center space-y-3">
                    <Camera className="w-10 h-10 text-sky-400 animate-pulse" />
                    <div className="space-y-1 max-w-xs">
                      <div className="text-sm font-bold text-white">Meminta Izin Pengaktifan Kamera</div>
                      <p className="text-xs text-slate-300">
                        Klik &ldquo;Izinkan / Allow&rdquo; pada dialog perangkat atau ketuk tombol di bawah agar kamera langsung terbuka.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void startCamera(undefined, true)}
                      className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-lg cursor-pointer transition"
                    >
                      Izinkan &amp; Aktifkan Kamera
                    </button>
                  </div>
                )}
              </CameraPreviewStage>
            )}

            {!isCameraActive && (
              <div className="p-8 text-center space-y-5 max-w-md mx-auto">
                <div className="w-20 h-20 mx-auto rounded-3xl bg-blue-600/20 text-blue-400 border border-blue-500/30 flex items-center justify-center shadow-lg">
                  <Camera className="w-10 h-10" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-xl font-bold text-white">Deteksi Wajah Siswa</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Kamera mencocokkan wajah dengan database wajah siswa, memunculkan bingkai + nama siswa yang cocok (kanan di kanan, kiri di kiri).
                  </p>
                </div>

                {cameraError && (
                  <div className="p-3.5 rounded-2xl bg-red-950/70 border border-red-800 text-left text-xs text-red-300 space-y-1">
                    <div className="font-bold flex items-center gap-1.5 text-red-200">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>{cameraError.title}</span>
                    </div>
                    <p>{cameraError.message}</p>
                  </div>
                )}

                <button
                  onClick={() => void startCamera(undefined, true)}
                  className="w-full py-4 px-6 rounded-2xl text-base font-bold text-white bg-blue-600 hover:bg-blue-500 active:scale-98 shadow-lg shadow-blue-600/30 transition flex items-center justify-center gap-3 cursor-pointer"
                >
                  <Camera className="w-5 h-5" />
                  <span>{cameraError ? 'Izinkan & Coba Lagi' : 'Aktifkan Kamera'}</span>
                </button>
              </div>
            )}

            {isCameraActive && (
              <div className="absolute top-3 sm:top-4 left-3 sm:left-4 right-3 sm:right-4 flex flex-wrap items-center justify-between gap-2 pointer-events-auto">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/65 backdrop-blur-md text-white text-xs font-medium border border-white/10">
                  <span
                    className={`w-2 h-2 rounded-full animate-pulse ${
                      isRequestingCamera
                        ? 'bg-sky-400'
                        : modelStatus === 'ready'
                          ? 'bg-emerald-500'
                          : 'bg-amber-400'
                    }`}
                  />
                  <span>
                    {isRequestingCamera
                      ? 'Meminta izin pengaktifan kamera...'
                      : modelStatus === 'ready'
                        ? `Frame Wajah Aktif • ${studentFaceTemplates.length} DB (${mirrorPreview ? 'Kanan di Kanan' : 'Sensor Asli'})`
                        : modelStatus === 'error'
                          ? 'Kamera Aktif • Mode Scan Kartu'
                          : 'Kamera Aktif • Menyiapkan AI...'}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 sm:gap-2">
                  <button
                    type="button"
                    onClick={() => setMirrorPreview((v) => !v)}
                    className="px-2.5 py-1.5 rounded-xl bg-black/65 backdrop-blur-md text-white hover:bg-black/80 border border-white/10 text-[11px] font-semibold transition"
                    title="Sesuaikan orientasi tampilan preview (AI tetap memakai gambar asli)"
                  >
                    {mirrorPreview ? 'Orientasi: Kanan=Kanan' : 'Orientasi: Sensor Asli'}
                  </button>
                  <button
                    onClick={switchCamera}
                    className="p-2 rounded-xl bg-black/65 backdrop-blur-md text-white hover:bg-black/80 border border-white/10 transition"
                    title="Ganti Kamera Depan/Belakang"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                  <button
                    onClick={stopCamera}
                    className="px-3 py-1.5 rounded-xl bg-red-600/85 backdrop-blur-md text-white hover:bg-red-700 text-xs font-semibold transition"
                  >
                    Hentikan
                  </button>
                </div>
              </div>
            )}

            {/* Live Recognized Face Name Banner + Quick Check-in */}
            {isCameraActive && detectedStudentsInFrame.length > 0 && (
              <div className="absolute bottom-3 sm:bottom-4 left-3 sm:left-4 right-3 sm:right-4 flex flex-col gap-2 pointer-events-auto">
                {detectedStudentsInFrame.map(({ student }) => {
                  const clsName = classes.find((c) => c.id === student.classId)?.name;
                  const alreadyDone = sessionTodayAttendance.find((a) => a.studentId === student.id);
                  return (
                    <div
                      key={student.id}
                      className={`p-3 rounded-2xl backdrop-blur-md text-white shadow-xl border flex flex-wrap items-center justify-between gap-3 ${
                        alreadyDone
                          ? 'bg-slate-800/90 border-slate-600/60'
                          : 'bg-emerald-600/95 border-emerald-300/60'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                          <UserCheck className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-100">
                            Wajah Cocok Dengan Database
                          </div>
                          <div className="text-sm sm:text-base font-black leading-tight">
                            {student.name}
                          </div>
                          <div className="text-[11px] text-white/85">
                            {clsName ? `${clsName} • ` : ''}NIS: {student.nis}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={!activeStudentSession}
                        onClick={() =>
                          void submitStudentAttendance(
                            student,
                            student.barcodeCard || student.nis,
                            'FACE_SCAN'
                          )
                        }
                        className={`px-4 py-2 rounded-xl text-xs font-bold transition shadow ${
                          !activeStudentSession
                            ? 'bg-slate-700 text-slate-300 cursor-not-allowed'
                            : alreadyDone
                              ? 'bg-slate-700 text-slate-200 cursor-default'
                              : 'bg-white text-emerald-700 hover:bg-emerald-50 cursor-pointer'
                        }`}
                      >
                        {!activeStudentSession
                          ? 'Di Luar Jam Sesi'
                          : alreadyDone
                            ? `Sudah Presensi (${alreadyDone.timeIn})`
                            : 'Catat Presensi'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {isCameraActive && hasFaceInFrame && detectedStudentsInFrame.length === 0 && (
              <div className="absolute bottom-12 left-5 right-5 pointer-events-none flex justify-center">
                <div className="px-4 py-2 rounded-xl bg-amber-500/90 backdrop-blur-md text-white text-xs font-bold shadow-lg">
                  Wajah terdeteksi — belum cocok dengan database wajah siswa
                </div>
              </div>
            )}

            <div className="w-full mt-2 flex items-center justify-between text-[11px] text-slate-400 bg-black/50 px-3.5 py-1.5 rounded-xl border border-white/5 pointer-events-none">
              <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                <ShieldCheck className="w-3.5 h-3.5" />
                Privasi: Hanya mencocokkan wajah, tanpa menyimpan foto.
              </span>
              <span>DB Wajah: {studentFaceTemplates.length} Siswa</span>
            </div>
          </div>

          {/* 3. Quick Action Buttons */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <button
              onClick={() => setShowManualModal(true)}
              className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-400 dark:hover:border-blue-500 transition shadow-sm text-left group"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">Petugas Piket</span>
                <Users className="w-4 h-4 text-slate-400 group-hover:text-blue-500 transition" />
              </div>
              <div className="font-bold text-slate-900 dark:text-white text-base">Presensi Manual</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Input Izin, Sakit, Alpa oleh guru/petugas
              </div>
            </button>

            <button
              onClick={() => setShowToiletModal(true)}
              className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-amber-400 dark:hover:border-amber-500 transition shadow-sm text-left group"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">Timer Hitung Mundur</span>
                <Timer className="w-4 h-4 text-slate-400 group-hover:text-amber-500 transition" />
              </div>
              <div className="font-bold text-slate-900 dark:text-white text-base">Menu Izin Toilet / Keluar</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Ketik nama • BAK {bakMinutes}m / BAB {babMinutes}m / Lainnya {otherMinutes}m
              </div>
            </button>
          </div>
        </div>

        {/* Monitoring Panels Below Centered Stage: Active Toilet Permits, Frequent Toilet List & Today Attendance */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Card: Siswa Sedang Izin Keluar Kelas (Always visible with live countdown + checkmark) */}
          <div className="p-5 rounded-3xl bg-amber-500/10 border border-amber-500/30 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    activePermits.length > 0 ? 'bg-amber-500 animate-ping' : 'bg-emerald-500'
                  }`}
                />
                <h3 className="font-bold text-sm text-amber-900 dark:text-amber-200">
                  Siswa Sedang Izin Keluar Kelas ({activePermits.length})
                </h3>
              </div>
              <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                BAB {babMinutes}m • BAK {bakMinutes}m
              </span>
            </div>

            {activePermits.length === 0 ? (
              <div className="p-3.5 rounded-2xl bg-white/80 dark:bg-slate-900/80 border border-amber-200/70 dark:border-amber-900/50 text-xs text-slate-500 dark:text-slate-400 text-center">
                Saat ini tidak ada siswa yang izin keluar kelas.
              </div>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {activePermits.map((permit) => {
                  const cd = computePermitCountdown(permit, babMinutes, bakMinutes, otherMinutes, nowMs);
                  const isBusy = returningPermitId === permit.id;
                  return (
                    <div
                      key={permit.id}
                      className={`p-3 rounded-2xl bg-white dark:bg-slate-900 border flex items-center justify-between gap-3 text-xs transition ${
                        cd.isExpired
                          ? 'border-red-400 dark:border-red-700 bg-red-50/70 dark:bg-red-950/30'
                          : 'border-amber-200 dark:border-amber-900'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold text-slate-900 dark:text-white truncate">
                            {permit.studentName}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              cd.type === 'BAB'
                                ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                                : cd.type === 'LAINNYA'
                                ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                                : 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                            }`}
                          >
                            {cd.typeLabel} ({cd.limitMinutes}m)
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {permit.className ? `${permit.className} • ` : ''}Keluar {permit.timeOut} WIB
                          {permit.reason ? ` • ${permit.reason}` : ''}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        <div
                          className={`px-2.5 py-1.5 rounded-xl font-mono font-black text-xs flex items-center gap-1 ${
                            cd.isExpired
                              ? 'bg-red-600 text-white animate-pulse'
                              : cd.isWarning
                              ? 'bg-amber-500 text-white'
                              : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          }`}
                          title={cd.isExpired ? 'Melebihi batas waktu izin' : 'Sisa waktu hitung mundur'}
                        >
                          <Timer className="w-3.5 h-3.5" />
                          <span>{cd.formatted}</span>
                        </div>

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleConfirmToiletReturn(permit)}
                          title="Konfirmasi Kembali / Selesai"
                          aria-label={`Konfirmasi ${permit.studentName} kembali / selesai`}
                          className="w-9 h-9 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white flex items-center justify-center shadow transition disabled:opacity-50"
                        >
                          {isBusy ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-5 h-5 stroke-[2.5]" />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card: Siswa Sering Izin Keluar Kelas */}
          <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-500" />
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                  Siswa Sering Izin Keluar Kelas
                </h3>
              </div>
              <span className="text-[11px] font-semibold text-slate-400">
                {frequentToiletStudents.length} Siswa
              </span>
            </div>

            {frequentToiletStudents.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-400">
                Belum ada riwayat siswa izin keluar kelas.
              </div>
            ) : (
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {frequentToiletStudents.slice(0, 8).map((item: FrequentToiletStudent, idx: number) => (
                  <div
                    key={item.studentId}
                    className="p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`w-6 h-6 rounded-lg font-black text-[11px] flex items-center justify-center flex-shrink-0 ${
                          idx === 0
                            ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
                            : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 dark:text-white truncate">
                          {item.studentName}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {item.className || 'Kelas'} • BAB {item.babCount}x • BAK {item.bakCount}x
                          {(item.otherCount || 0) > 0 ? ` • Lainnya ${item.otherCount}x` : ''}
                        </div>
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <span className="inline-block px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 font-bold text-[11px]">
                        {item.totalCount}x Izin
                      </span>
                      {item.exceededCount > 0 && (
                        <div className="text-[10px] font-bold text-rose-600 dark:text-rose-400 mt-0.5">
                          {item.exceededCount}x Telat
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Attendance Today Card (Auto-reloads continuously per active session, isolated from other sessions) */}
          <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                Sudah Presensi Hari Ini {activeStudentSession ? `— ${activeStudentSession.name}` : ''}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {activeStudentSession
                  ? `Total ${sessionTodayAttendance.length} siswa tercatat di Sheet "${activeStudentSession.sheetName}"`
                  : 'Menunggu sesi presensi siswa aktif (sinkron otomatis).'}
              </p>
            </div>

            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
              {sessionTodayAttendance.length === 0 ? (
                <div className="py-10 text-center text-slate-400 text-xs">
                  {activeStudentSession
                    ? `Belum ada siswa yang presensi pada sesi ${activeStudentSession.name} hari ini.`
                    : 'Tidak ada sesi presensi siswa yang sedang aktif.'}
                </div>
              ) : (
                sessionTodayAttendance.map((item) => (
                  <div
                    key={item.id}
                    className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 flex items-center justify-between transition hover:border-slate-300 dark:hover:border-slate-700"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-bold flex items-center justify-center text-xs">
                        {item.studentName ? item.studentName.charAt(0) : 'S'}
                      </div>
                      <div>
                        <div className="text-xs font-bold text-slate-900 dark:text-white line-clamp-1">
                          {item.studentName || 'Siswa'}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {item.className ? `${item.className} • ` : ''}
                          NIS: {item.studentNis || '-'}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                          item.status === 'Hadir'
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                            : item.status === 'Terlambat'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                            : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                        }`}
                      >
                        {item.status}
                      </span>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">{item.timeIn}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {showManualModal && (
        <ManualAttendanceModal
          classes={classes}
          students={students}
          studentSessions={studentSessions}
          activeStudentSession={activeStudentSession}
          onClose={() => setShowManualModal(false)}
          onSuccess={() => {
            setShowManualModal(false);
            void notifyFaceDatabaseChanged();
          }}
        />
      )}

      {showToiletModal && (
        <ToiletPermitModal
          students={students}
          classes={classes}
          activePermits={activePermits}
          frequentToiletStudents={frequentToiletStudents}
          babMinutes={babMinutes}
          bakMinutes={bakMinutes}
          otherMinutes={otherMinutes}
          nowMs={nowMs}
          onConfirmReturn={handleConfirmToiletReturn}
          returningPermitId={returningPermitId}
          onClose={() => setShowToiletModal(false)}
          onSuccess={() => {
            setShowToiletModal(false);
            void notifyFaceDatabaseChanged();
          }}
        />
      )}
    </div>
  );
};

// Modal: Presensi Manual (Petugas Piket)
const ManualAttendanceModal: React.FC<{
  classes: SchoolClass[];
  students: Student[];
  studentSessions: AttendanceSession[];
  activeStudentSession: AttendanceSession | null;
  onClose: () => void;
  onSuccess: () => void;
}> = ({ classes, students, studentSessions, activeStudentSession, onClose, onSuccess }) => {
  const [selectedClassId, setSelectedClassId] = useState<string>(classes[0]?.id || '');
  const [selectedStudentId, setSelectedStudentId] = useState<string>('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>(
    activeStudentSession?.id || studentSessions[0]?.id || ''
  );
  const [status, setStatus] = useState<'Hadir' | 'Terlambat' | 'Izin' | 'Sakit' | 'Alpa'>('Izin');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredStudents = students.filter((s) => s.classId === selectedClassId && s.isActive);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStudentId) {
      setError('Pilih siswa terlebih dahulu.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await postWithOfflineFallback('manualStudentAttendance', {
        studentId: selectedStudentId,
        status,
        notes,
        sessionId: selectedSessionId || undefined,
      });

      if (res.success) {
        onSuccess();
      } else {
        setError(res.error || 'Gagal menyimpan presensi manual.');
      }
    } catch (err: any) {
      setError(err?.message || 'Terjadi kesalahan.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-lg max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
        <h3 className="text-lg font-bold text-slate-900 dark:text-white">Presensi Manual Petugas</h3>
        <p className="text-xs text-slate-500 mb-5">Tercatat ke Sheet khusus sesi yang dipilih dan masuk ke sheet Log.</p>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {studentSessions.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Sesi Presensi Siswa (24 Jam WIB)
              </label>
              <select
                value={selectedSessionId}
                onChange={(e) => setSelectedSessionId(e.target.value)}
                className="w-full px-4 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
              >
                {studentSessions.map((ses) => (
                  <option key={ses.id} value={ses.id}>
                    {ses.name} ({ses.startTime}–{ses.endTime} WIB) • {ses.sheetName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Pilih Kelas</label>
            <select
              value={selectedClassId}
              onChange={(e) => {
                setSelectedClassId(e.target.value);
                setSelectedStudentId('');
              }}
              className="w-full px-4 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            >
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Pilih Siswa</label>
            <select
              value={selectedStudentId}
              onChange={(e) => setSelectedStudentId(e.target.value)}
              className="w-full px-4 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            >
              <option value="">-- Pilih Siswa ({filteredStudents.length} siswa) --</option>
              {filteredStudents.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nis} - {s.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Status Presensi</label>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {(['Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa'] as const).map((st) => (
                <button
                  type="button"
                  key={st}
                  onClick={() => setStatus(st)}
                  className={`py-2 text-xs font-bold rounded-xl border transition ${
                    status === st
                      ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                      : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Keterangan / Alasan
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Contoh: Sakit demam ada surat dokter"
              className="w-full px-4 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            />
          </div>

          <div className="mt-6 flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 text-sm font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow-md disabled:opacity-50"
            >
              {isSubmitting ? 'Menyimpan...' : 'Simpan Presensi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Modal: Menu Izin ke Toilet / Keluar Kelas (Ketik Nama Dulu -> Pilih BAK / BAB / Izin Lainnya -> Centang Kembali/Selesai)
const ToiletPermitModal: React.FC<{
  students: Student[];
  classes: SchoolClass[];
  activePermits: ToiletPermit[];
  frequentToiletStudents: FrequentToiletStudent[];
  babMinutes: number;
  bakMinutes: number;
  otherMinutes: number;
  nowMs: number;
  onConfirmReturn: (permit: ToiletPermit) => Promise<void>;
  returningPermitId: string | null;
  onClose: () => void;
  onSuccess: () => void;
}> = ({
  students,
  classes,
  activePermits,
  frequentToiletStudents,
  babMinutes,
  bakMinutes,
  otherMinutes,
  nowMs,
  onConfirmReturn,
  returningPermitId,
  onClose,
  onSuccess,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [toiletType, setToiletType] = useState<'BAK' | 'BAB' | 'LAINNYA'>('BAK');
  const [customReason, setCustomReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedQuery = searchTerm.trim();
  const filtered = trimmedQuery.length === 0
    ? []
    : students
        .filter(
          (s) =>
            s.isActive &&
            (s.name.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
              s.nis.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
              s.barcodeCard.toLowerCase().includes(trimmedQuery.toLowerCase()))
        )
        .slice(0, 10);

  const selectedLimitMinutes =
    toiletType === 'BAB' ? babMinutes : toiletType === 'BAK' ? bakMinutes : otherMinutes;

  const handleStartPermit = async () => {
    if (!selectedStudent) {
      setError('Ketik nama dan pilih siswa terlebih dahulu.');
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await postWithOfflineFallback('toiletStart', {
        studentId: selectedStudent.id,
        toiletType,
        reason: toiletType === 'LAINNYA' ? customReason.trim() : '',
      });

      if (res.success) {
        onSuccess();
      } else {
        setError(res.error || 'Gagal mencatat izin keluar kelas.');
      }
    } catch (err: any) {
      setError(err?.message || 'Terjadi kesalahan.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Menu Izin Keluar Kelas</h3>
            <p className="text-xs text-slate-500">
              Ketik nama siswa dulu, lalu tentukan izin BAK ({bakMinutes}m), BAB ({babMinutes}m), atau Izin Lainnya ({otherMinutes}m).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 flex-shrink-0"
          >
            Tutup
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs">
            {error}
          </div>
        )}

        {/* Section 1: Langkah 1 Ketik Nama Siswa -> Langkah 2 Tentukan Jenis Izin */}
        <div className="space-y-4 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          {/* Langkah 1: Ketik Nama Dulu */}
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-2">
              1. Ketik Nama atau NIS Siswa
            </label>
            {selectedStudent ? (
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-black text-slate-900 dark:text-white truncate">
                    {selectedStudent.name}
                  </div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-300">
                    {classes.find((c) => c.id === selectedStudent.classId)?.name || 'Kelas'} • NIS: {selectedStudent.nis}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedStudent(null);
                    setSearchTerm('');
                  }}
                  className="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 flex-shrink-0"
                >
                  Ganti Siswa
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    autoFocus
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Ketik nama atau NIS siswa terlebih dahulu..."
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                {trimmedQuery.length === 0 ? (
                  <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                    Ketik minimal 1 huruf nama atau NIS siswa untuk memilih siswa.
                  </p>
                ) : filtered.length === 0 ? (
                  <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                    Siswa dengan kata kunci "{trimmedQuery}" tidak ditemukan.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-40 overflow-y-auto mt-2">
                    {filtered.map((s) => {
                      const cls = classes.find((c) => c.id === s.classId);
                      return (
                        <button
                          type="button"
                          key={s.id}
                          onClick={() => setSelectedStudent(s)}
                          className="w-full p-2.5 rounded-xl border text-left flex items-center justify-between text-xs transition bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:border-amber-400 hover:bg-amber-50/40 dark:hover:bg-amber-950/20"
                        >
                          <div>
                            <div className="font-bold">{s.name}</div>
                            <div className="text-[11px] opacity-75">
                              {cls?.name || 'Kelas'} • NIS: {s.nis}
                            </div>
                          </div>
                          <span className="font-bold text-amber-600 text-[11px]">Pilih</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Langkah 2: Tentukan Izin BAB / BAK / Izin Lainnya */}
          <div className={!selectedStudent ? 'opacity-60' : ''}>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-2">
              2. Tentukan Jenis Izin
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => setToiletType('BAK')}
                className={`p-3 rounded-xl border text-left transition ${
                  toiletType === 'BAK'
                    ? 'bg-sky-600 text-white border-sky-600 shadow-md'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                }`}
              >
                <div className="font-black text-sm">BAK</div>
                <div className={`text-[11px] mt-0.5 ${toiletType === 'BAK' ? 'text-sky-100' : 'text-slate-500'}`}>
                  Buang Air Kecil • {bakMinutes} menit
                </div>
              </button>

              <button
                type="button"
                onClick={() => setToiletType('BAB')}
                className={`p-3 rounded-xl border text-left transition ${
                  toiletType === 'BAB'
                    ? 'bg-purple-600 text-white border-purple-600 shadow-md'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                }`}
              >
                <div className="font-black text-sm">BAB</div>
                <div className={`text-[11px] mt-0.5 ${toiletType === 'BAB' ? 'text-purple-100' : 'text-slate-500'}`}>
                  Buang Air Besar • {babMinutes} menit
                </div>
              </button>

              <button
                type="button"
                onClick={() => setToiletType('LAINNYA')}
                className={`p-3 rounded-xl border text-left transition ${
                  toiletType === 'LAINNYA'
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                }`}
              >
                <div className="font-black text-sm">Izin Lainnya</div>
                <div className={`text-[11px] mt-0.5 ${toiletType === 'LAINNYA' ? 'text-indigo-100' : 'text-slate-500'}`}>
                  Keperluan lain • {otherMinutes} menit
                </div>
              </button>
            </div>

            {toiletType === 'LAINNYA' && (
              <div className="mt-3">
                <input
                  type="text"
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                  placeholder="Keterangan izin lainnya (mis. UKS, ambil buku, dipanggil guru)..."
                  className="w-full px-3.5 py-2.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            )}
          </div>

          {selectedStudent && (
            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <span>
                Siswa: <strong>{selectedStudent.name}</strong> •{' '}
                <strong>{toiletType === 'LAINNYA' ? 'Izin Lainnya' : toiletType}</strong> ({selectedLimitMinutes} menit)
                {toiletType === 'LAINNYA' && customReason.trim() ? ` — ${customReason.trim()}` : ''}
              </span>
              <button
                type="button"
                onClick={handleStartPermit}
                disabled={isSubmitting}
                className="px-4 py-2.5 text-xs font-bold rounded-xl bg-amber-500 hover:bg-amber-600 text-white shadow disabled:opacity-50 flex-shrink-0"
              >
                {isSubmitting ? 'Mencatat...' : 'Mulai Timer Izin'}
              </button>
            </div>
          )}
        </div>

        {/* Section 2: Siswa Sedang Izin Keluar & Sering Izin */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-2.5">
            <h4 className="text-xs font-bold text-amber-900 dark:text-amber-200">
              Sedang Izin Keluar Kelas ({activePermits.length})
            </h4>
            {activePermits.length === 0 ? (
              <p className="text-[11px] text-slate-500">Tidak ada siswa yang sedang di luar kelas.</p>
            ) : (
              <div className="space-y-2 max-h-44 overflow-y-auto">
                {activePermits.map((permit) => {
                  const cd = computePermitCountdown(permit, babMinutes, bakMinutes, otherMinutes, nowMs);
                  const isBusy = returningPermitId === permit.id;
                  return (
                    <div
                      key={permit.id}
                      className="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 dark:text-white truncate">
                          {permit.studentName}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate">
                          {cd.typeLabel} • Keluar {permit.timeOut}
                          {permit.reason ? ` (${permit.reason})` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span
                          className={`px-2 py-1 rounded-lg font-mono font-bold text-[11px] ${
                            cd.isExpired
                              ? 'bg-red-600 text-white'
                              : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          }`}
                        >
                          {cd.formatted}
                        </span>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void onConfirmReturn(permit)}
                          title="Konfirmasi Kembali / Selesai"
                          aria-label={`Konfirmasi ${permit.studentName} kembali / selesai`}
                          className="w-8 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white flex items-center justify-center shadow-xs disabled:opacity-50"
                        >
                          {isBusy ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-4 h-4 stroke-[2.5]" />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2.5">
            <h4 className="text-xs font-bold text-slate-900 dark:text-white">
              Sering Izin Keluar Kelas
            </h4>
            {frequentToiletStudents.length === 0 ? (
              <p className="text-[11px] text-slate-400">Belum ada riwayat izin keluar kelas.</p>
            ) : (
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {frequentToiletStudents.slice(0, 6).map((item) => (
                  <div
                    key={item.studentId}
                    className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-slate-900 dark:text-white truncate">
                        {item.studentName}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {item.className || 'Kelas'} • BAB {item.babCount}x • BAK {item.bakCount}x
                        {(item.otherCount || 0) > 0 ? ` • Lainnya ${item.otherCount}x` : ''}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 font-bold text-[10px] flex-shrink-0">
                      {item.totalCount}x
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
