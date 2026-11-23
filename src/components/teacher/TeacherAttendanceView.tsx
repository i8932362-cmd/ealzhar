import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  Camera,
  CheckCircle2,
  AlertCircle,
  Briefcase,
  History,
  FileText,
  Navigation,
  RefreshCw,
  RotateCcw,
  ArrowLeft,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  ShieldCheck,
  UserCheck,
  Clock,
  Filter,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { useAuth } from '../../context/AuthContext.tsx';
import { useSync } from '../../context/SyncContext.tsx';
import { TeacherAttendance, SchoolLocation, Teacher } from '../../types/index.ts';
import { gasGet, gasPost, getWibTodayStr } from '../../lib/api.ts';
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
  detectSingleFaceDescriptor,
  findBestFaceMatch,
  parseCameraError,
} from '../../lib/faceDetection.ts';
import { playSuccessChime, playErrorBeep, speakIndonesian } from '../../lib/soundEffects.ts';

export interface TeacherAttendanceViewProps {
  onReturnToPortal?: () => void;
}

function shiftUtcDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().split('T')[0];
}

function shiftMonthDate(dateStr: string, deltaMonths: number): string {
  const [y, m] = dateStr.split('-').map(Number);
  if (!y || !m) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return dt.toISOString().split('T')[0];
}

function getWeekBounds(dateStr: string): { start: string; end: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return { start: dateStr, end: dateStr };
  const dt = new Date(Date.UTC(y, m - 1, d));
  const diffToMon = (dt.getUTCDay() + 6) % 7;
  const start = new Date(dt);
  start.setUTCDate(dt.getUTCDate() - diffToMon);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

function formatIndoShort(dateStr: string): string {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('id-ID', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const TeacherAttendanceView: React.FC<TeacherAttendanceViewProps> = ({ onReturnToPortal }) => {
  const { user } = useAuth();
  const {
    settings,
    locations,
    teachers,
    faceTemplates,
    sessions,
    activeTeacherSession,
    wibNowHhMm,
    serverVersion,
    serverDate,
    notifyFaceDatabaseChanged,
  } = useSync();

  const teacherSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.targetType === 'teacher')),
    [sessions]
  );

  const nextTeacherSession = useMemo(
    () => (activeTeacherSession ? null : getNextUpcomingSessionForType(sessions, 'teacher', wibNowHhMm)),
    [sessions, activeTeacherSession, wibNowHhMm]
  );

  // Location state
  const [gpsLoading, setGpsLoading] = useState<boolean>(true);
  const [currentCoords, setCurrentCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [nearestLocation, setNearestLocation] = useState<{ location: SchoolLocation; distanceMeters: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Camera & Face state (instant open without loading screen)
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [isRequestingCamera, setIsRequestingCamera] = useState<boolean>(true);
  const [videoAspect, setVideoAspect] = useState<number>(4 / 3);
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(() =>
    areFaceModelsLoaded() ? 'ready' : 'idle'
  );
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [mirrorPreview, setMirrorPreview] = useState<boolean>(true);
  const [needsPlayTap, setNeedsPlayTap] = useState<boolean>(false);
  const mirrorPreviewRef = useRef<boolean>(true);
  mirrorPreviewRef.current = mirrorPreview;
  const [cameraError, setCameraError] = useState<{ title: string; message: string } | null>(null);
  const [matchedTeacherInFrame, setMatchedTeacherInFrame] = useState<{ name: string; nip: string } | null>(null);
  const [hasFaceInFrame, setHasFaceInFrame] = useState<boolean>(false);
  const [earlyCheckoutAutoEnabled, setEarlyCheckoutAutoEnabled] = useState<boolean>(false);
  const [liveClock24, setLiveClock24] = useState<string>(() => formatWibTime24(new Date(), true));

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const isDetectingRef = useRef<boolean>(false);
  const lastDetectTimeRef = useRef<number>(0);
  const consecutiveMatchRef = useRef<{ personId: string; count: number }>({ personId: '', count: 0 });
  const isSubmittingRef = useRef<boolean>(false);
  const autoTriggeredSessionRef = useRef<string | null>(null);
  const mountedRef = useRef<boolean>(true);
  const cameraExpectedActiveRef = useRef<boolean>(true);
  const facingModeRef = useRef<'user' | 'environment'>('user');
  facingModeRef.current = facingMode;

  const todayStr = serverDate || getWibTodayStr();
  const [history, setHistory] = useState<TeacherAttendance[]>([]);
  const [teacherDisplayName, setTeacherDisplayName] = useState<string>('');
  const [teacherDisplayNip, setTeacherDisplayNip] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [recapMode, setRecapMode] = useState<'daily' | 'weekly' | 'monthly' | 'range' | 'all'>('daily');
  const [sessionFilter, setSessionFilter] = useState<string>('ALL');
  const [rangeStartDate, setRangeStartDate] = useState<string>(() => shiftUtcDate(todayStr, -6));
  const [rangeEndDate, setRangeEndDate] = useState<string>(todayStr);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Resolve logged-in teacher profile from synced Teachers list
  const myTeacher = useMemo(() => {
    if (!user) return undefined;
    const userNip = String(user.nip || '').trim();
    const userEmail = String(user.email || '').trim().toLowerCase();
    const userName = String(user.name || '').trim().toLowerCase();
    return teachers.find(
      (t) =>
        t.isActive &&
        ((user.teacherId && t.id === user.teacherId) ||
          (userNip && String(t.nip || '').trim() === userNip) ||
          (userEmail && String(t.email || '').trim().toLowerCase() === userEmail) ||
          (userName && String(t.name || '').trim().toLowerCase() === userName))
    );
  }, [teachers, user]);

  const teacherFaceTemplates = useMemo(() => {
    return faceTemplates.filter(
      (f) => f.personType === 'teacher' && Array.isArray(f.descriptor) && f.descriptor.length > 0
    );
  }, [faceTemplates]);

  const myFaceTemplate = useMemo(() => {
    if (!myTeacher) return undefined;
    return teacherFaceTemplates.find((f) => f.personId === myTeacher.id);
  }, [teacherFaceTemplates, myTeacher]);

  const [showPermitModal, setShowPermitModal] = useState<boolean>(false);
  const [permitType, setPermitType] = useState<'Izin' | 'Sakit'>('Izin');
  const [permitNotes, setPermitNotes] = useState<string>('');
  const [permitSessionId, setPermitSessionId] = useState<string>('');

  useEffect(() => {
    if (showPermitModal) {
      setPermitSessionId(activeTeacherSession?.id || teacherSessions[0]?.id || '');
    }
  }, [showPermitModal, activeTeacherSession?.id, teacherSessions]);

  const loadTeacherHistory = useCallback(async () => {
    if (!user) return;
    try {
      const res = await gasGet<TeacherAttendance[]>('teacherHistory', {
        userId: user.id,
        teacherId: user.teacherId || myTeacher?.id || '',
        userNip: user.nip || myTeacher?.nip || '',
        userEmail: user.email || myTeacher?.email || '',
        userName: user.name || myTeacher?.name || '',
      });
      if (res.success && Array.isArray(res.data)) {
        setHistory(res.data);
      }
      if (res.teacherName) setTeacherDisplayName(String(res.teacherName));
      if (res.teacherNip) setTeacherDisplayNip(String(res.teacherNip));
    } catch (err) {
      console.error('Error loading teacher history:', err);
    }
  }, [user, myTeacher]);

  useEffect(() => {
    void loadTeacherHistory();
  }, [loadTeacherHistory, serverVersion]);

  const requestLocation = useCallback(() => {
    setGpsLoading(true);
    setGpsError(null);

    if (!navigator.geolocation) {
      setGpsError('Perangkat Anda tidak mendukung fitur Geolocation GPS.');
      setGpsLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setCurrentCoords({ lat: latitude, lng: longitude });
        setGpsLoading(false);
      },
      () => {
        setGpsLoading(false);
        setGpsError('Gagal mendapatkan lokasi GPS. Pastikan izin lokasi telah aktif.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }, []);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  useEffect(() => {
    const activeLocs = locations.filter((l) => l.isActive);
    if (!currentCoords || activeLocs.length === 0) return;

    let min = Infinity;
    let best: SchoolLocation | null = null;
    const toRad = (x: number) => (x * Math.PI) / 180;
    const R = 6371e3;

    for (const loc of activeLocs) {
      const dLat = toRad(loc.latitude - currentCoords.lat);
      const dLon = toRad(loc.longitude - currentCoords.lng);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(currentCoords.lat)) *
          Math.cos(toRad(loc.latitude)) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const dist = Math.round(R * c);

      if (dist < min) {
        min = dist;
        best = loc;
      }
    }

    if (best) {
      setNearestLocation({ location: best, distanceMeters: min });
    }
  }, [currentCoords, locations]);

  // Keep strict 24-hour WIB clock updated every 1s
  useEffect(() => {
    const timer = window.setInterval(() => {
      setLiveClock24(formatWibTime24(new Date(), true));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Reset per-session automation state when active teacher session switches automatically
  useEffect(() => {
    autoTriggeredSessionRef.current = null;
    consecutiveMatchRef.current = { personId: '', count: 0 };
    setEarlyCheckoutAutoEnabled(false);
  }, [activeTeacherSession?.id]);

  // Strict per-session isolation: todayRecord only matches the currently active teacher session!
  const todayRecord = useMemo(() => {
    if (!activeTeacherSession) return undefined;
    return history.find(
      (h) => h.date === todayStr && String(h.sessionId || '') === String(activeTeacherSession.id)
    );
  }, [history, todayStr, activeTeacherSession]);

  const checkOutTime = activeTeacherSession?.endTime || settings?.checkOutTime || '15:00';

  const activeAutoSession: 'outsideSession' | 'checkIn' | 'checkOut' | 'waitingCheckOut' | 'completed' =
    useMemo(() => {
      if (!activeTeacherSession) return 'outsideSession';
      if (!todayRecord) return 'checkIn';
      if (todayRecord.status === 'Izin' || todayRecord.status === 'Sakit' || todayRecord.timeOut) {
        return 'completed';
      }
      if (todayRecord.timeIn) {
        return wibNowHhMm >= checkOutTime || earlyCheckoutAutoEnabled ? 'checkOut' : 'waitingCheckOut';
      }
      return 'checkIn';
    }, [activeTeacherSession, todayRecord, wibNowHhMm, checkOutTime, earlyCheckoutAutoEnabled]);

  const activeLocationsCount = useMemo(() => locations.filter((l) => l.isActive).length, [locations]);
  const isInsideRadius = nearestLocation
    ? nearestLocation.distanceMeters <= nearestLocation.location.radiusMeters
    : activeLocationsCount === 0;

  // Refs synced for real-time face detection loop
  const stateRef = useRef({
    myTeacher,
    myFaceTemplate,
    teacherFaceTemplates,
    teachers,
    user,
    activeTeacherSession,
    activeAutoSession,
    isInsideRadius,
    activeLocationsCount,
    gpsLoading,
    gpsError,
  });
  stateRef.current = {
    myTeacher,
    myFaceTemplate,
    teacherFaceTemplates,
    teachers,
    user,
    activeTeacherSession,
    activeAutoSession,
    isInsideRadius,
    activeLocationsCount,
    gpsLoading,
    gpsError,
  };

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
    };
  }, []);

  // Submit Check-In or Check-Out (NO photo captured or saved — stores only nama & nip on server)
  const submitAttendanceDirect = useCallback(
    async (
      actionType: 'checkIn' | 'checkOut',
      options?: {
        skipSingleFrameVerify?: boolean;
        matchedTeacher?: Teacher;
      }
    ) => {
      if (isSubmittingRef.current) return;
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setFeedback(null);

      try {
        if (!activeTeacherSession) {
          playErrorBeep();
          setFeedback({
            type: 'error',
            message: nextTeacherSession
              ? `Di luar jam sesi guru (${wibNowHhMm} WIB). Sesi berikutnya "${nextTeacherSession.name}" otomatis dibuka pukul ${nextTeacherSession.startTime}–${nextTeacherSession.endTime} WIB.`
              : `Di luar jam sesi presensi guru (${wibNowHhMm} WIB). Belum ada sesi guru aktif saat ini.`,
          });
          return;
        }

        // 1. Verify GPS radius
        if (nearestLocation && nearestLocation.distanceMeters > nearestLocation.location.radiusMeters) {
          playErrorBeep();
          setFeedback({
            type: 'error',
            message: `Di luar radius: Jarak Anda ${nearestLocation.distanceMeters}m dari ${nearestLocation.location.name} (Batas: ${nearestLocation.location.radiusMeters}m).`,
          });
          return;
        }

        // 2. Strict biometric face matching against Teacher FaceTemplates
        const mustVerifyFace = Boolean(myFaceTemplate) || teacherFaceTemplates.length > 0;
        let faceVerified = Boolean(options?.skipSingleFrameVerify);

        if (!faceVerified) {
          if (mustVerifyFace && (!isCameraActive || !videoRef.current)) {
            playErrorBeep();
            setFeedback({
              type: 'error',
              message: 'Kamera wajib diaktifkan untuk mencocokkan wajah dengan database wajah guru.',
            });
            return;
          }

          if (isCameraActive && videoRef.current) {
            const descriptor = await detectSingleFaceDescriptor(videoRef.current);
            if (!descriptor) {
              playErrorBeep();
              setFeedback({
                type: 'error',
                message: 'Wajah tidak terdeteksi jelas pada kamera. Hadapkan wajah tegak ke kamera.',
              });
              return;
            }

            if (myFaceTemplate) {
              const match = findBestFaceMatch(descriptor, [myFaceTemplate]);
              if (!match || !match.isMatch) {
                playErrorBeep();
                setFeedback({
                  type: 'error',
                  message: `Wajah tidak cocok dengan data wajah biometrik milik ${myTeacher?.name || user?.name}. Presensi ditolak.`,
                });
                return;
              }
              faceVerified = true;
            } else if (teacherFaceTemplates.length > 0) {
              const match = findBestFaceMatch(descriptor, teacherFaceTemplates);
              if (!match || !match.isMatch) {
                playErrorBeep();
                setFeedback({
                  type: 'error',
                  message: 'Wajah tidak cocok dengan database biometrik guru yang terdaftar.',
                });
                return;
              }
              faceVerified = true;
            }
          }
        }

        const resolvedTeacher = options?.matchedTeacher || myTeacher;

        // 3. Submit attendance (nama & nip only, ZERO photoBase64, strict per-session isolation)
        const res = await gasPost<{ attendance: TeacherAttendance }>('teacherAttendance', {
          actionType,
          sessionId: activeTeacherSession.id,
          teacherId: resolvedTeacher?.id || user?.id,
          teacherName: resolvedTeacher?.name || user?.name,
          teacherNip: resolvedTeacher?.nip || user?.nip || teacherDisplayNip || '',
          teacherEmail: resolvedTeacher?.email || user?.email || '',
          userId: user?.id,
          faceVerified,
          latitude: currentCoords?.lat,
          longitude: currentCoords?.lng,
          distanceMeters: nearestLocation?.distanceMeters,
        });

        if (res.success) {
          playSuccessChime();
          speakIndonesian(
            actionType === 'checkIn'
              ? `Presensi masuk sesi ${activeTeacherSession.name} berhasil untuk ${resolvedTeacher?.name || user?.name || 'guru'}`
              : `Presensi pulang sesi ${activeTeacherSession.name} berhasil untuk ${resolvedTeacher?.name || user?.name || 'guru'}`
          );
          confetti({ particleCount: 70, spread: 60 });
          setFeedback({ type: 'success', message: res.message || 'Presensi berhasil dicatat.' });
          stopCamera();
          await notifyFaceDatabaseChanged();
          await loadTeacherHistory();
        } else {
          playErrorBeep();
          setFeedback({ type: 'error', message: res.error || 'Gagal memproses presensi.' });
        }
      } catch (err: any) {
        playErrorBeep();
        setFeedback({ type: 'error', message: err?.message || 'Terjadi kesalahan sistem.' });
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      activeTeacherSession,
      nextTeacherSession,
      wibNowHhMm,
      nearestLocation,
      myFaceTemplate,
      teacherFaceTemplates,
      isCameraActive,
      myTeacher,
      user,
      teacherDisplayNip,
      currentCoords,
      notifyFaceDatabaseChanged,
      loadTeacherHistory,
    ]
  );

  const submitAttendanceRef = useRef(submitAttendanceDirect);
  submitAttendanceRef.current = submitAttendanceDirect;

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

        if (areFaceModelsLoaded() && !isDetectingRef.current && now - lastDetectTimeRef.current >= 140) {
          isDetectingRef.current = true;
          lastDetectTimeRef.current = now;

          detectFacesInVideo(video)
            .then((detections) => {
              const ctx = canvas.getContext('2d');
              const snap = stateRef.current;
              const templatesToCheck = snap.myFaceTemplate
                ? [snap.myFaceTemplate]
                : snap.teacherFaceTemplates;

              if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (detections.length > 0) {
                  setHasFaceInFrame(true);
                  const primary = detections[0];
                  const match = findBestFaceMatch(primary.descriptor, templatesToCheck);

                  let label = 'Wajah Tidak Cocok';
                  let isMatched = false;
                  let matchedObj: Teacher | undefined = snap.myTeacher;

                  if (match && match.isMatch) {
                    const confPct = Math.round(Math.max(0, 1 - match.distance) * 100);
                    const foundT = snap.teachers.find((t) => t.id === match.personId && t.isActive);
                    if (foundT) {
                      matchedObj = foundT;
                      label = `✓ ${foundT.name} (${confPct}%)`;
                      isMatched = true;
                    } else if (snap.myTeacher) {
                      label = `✓ ${snap.myTeacher.name} (${confPct}%)`;
                      isMatched = true;
                    }
                  }

                  detections.forEach((det) => {
                    const { box } = det;
                    const drawX = mirrorPreviewRef.current
                      ? Math.max(0, canvas.width - (box.x + box.width))
                      : box.x;
                    const color = isMatched ? '#10b981' : '#f59e0b';
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = color;
                    ctx.strokeRect(drawX, box.y, box.width, box.height);

                    // Corner accents matching biometric frame
                    const corner = Math.min(20, box.width * 0.22, box.height * 0.22);
                    ctx.lineWidth = 5;
                    ctx.beginPath();
                    ctx.moveTo(drawX, box.y + corner);
                    ctx.lineTo(drawX, box.y);
                    ctx.lineTo(drawX + corner, box.y);
                    ctx.moveTo(drawX + box.width - corner, box.y);
                    ctx.lineTo(drawX + box.width, box.y);
                    ctx.lineTo(drawX + box.width, box.y + corner);
                    ctx.moveTo(drawX, box.y + box.height - corner);
                    ctx.lineTo(drawX, box.y + box.height);
                    ctx.lineTo(drawX + corner, box.y + box.height);
                    ctx.moveTo(drawX + box.width - corner, box.y + box.height);
                    ctx.lineTo(drawX + box.width, box.y + box.height);
                    ctx.lineTo(drawX + box.width, box.y + box.height - corner);
                    ctx.stroke();

                    ctx.font = 'bold 14px Inter, sans-serif';
                    const textWidth = ctx.measureText(label).width;
                    const pillW = textWidth + 16;
                    const pillX = Math.max(4, Math.min(canvas.width - pillW - 4, drawX));
                    ctx.fillStyle = color;
                    ctx.fillRect(pillX, box.y > 30 ? box.y - 30 : box.y, pillW, 28);
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(label, pillX + 8, box.y > 30 ? box.y - 11 : box.y + 19);
                  });

                  if (isMatched && matchedObj) {
                    setMatchedTeacherInFrame({ name: matchedObj.name, nip: matchedObj.nip || '' });

                    // Track consecutive matching frames for instant & reliable session auto-attendance
                    if (consecutiveMatchRef.current.personId === matchedObj.id) {
                      consecutiveMatchRef.current.count += 1;
                    } else {
                      consecutiveMatchRef.current = { personId: matchedObj.id, count: 1 };
                    }

                    const session = snap.activeAutoSession;
                    const gpsOk = snap.activeLocationsCount === 0 || (!snap.gpsLoading && snap.isInsideRadius);
                    if (
                      snap.activeTeacherSession &&
                      consecutiveMatchRef.current.count >= 2 &&
                      (session === 'checkIn' || session === 'checkOut') &&
                      gpsOk &&
                      !isSubmittingRef.current &&
                      autoTriggeredSessionRef.current !== `${snap.activeTeacherSession.id}:${session}`
                    ) {
                      autoTriggeredSessionRef.current = `${snap.activeTeacherSession.id}:${session}`;
                      void submitAttendanceRef.current(session, {
                        skipSingleFrameVerify: true,
                        matchedTeacher: matchedObj,
                      });
                    }
                  } else {
                    setMatchedTeacherInFrame(null);
                    consecutiveMatchRef.current = { personId: '', count: 0 };
                  }
                } else {
                  setHasFaceInFrame(false);
                  setMatchedTeacherInFrame(null);
                  consecutiveMatchRef.current = { personId: '', count: 0 };
                }
              }
            })
            .catch((err) => {
              console.debug('Teacher face detection cycle error:', err);
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

  const startCamera = async (modeOverride?: 'user' | 'environment') => {
    const targetMode = modeOverride || facingMode;
    cameraExpectedActiveRef.current = true;
    setCameraError(null);
    setNeedsPlayTap(false);
    setIsCameraActive(true);
    setIsRequestingCamera(true);
    autoTriggeredSessionRef.current = null;
    consecutiveMatchRef.current = { personId: '', count: 0 };

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

      const stream = await acquireCameraStream(targetMode);
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
      setIsCameraActive(true);
      setIsRequestingCamera(false);
      startDetectionLoop();
    } catch (err: any) {
      if (!mountedRef.current) return;
      cameraExpectedActiveRef.current = false;
      setIsCameraActive(false);
      setIsRequestingCamera(false);
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
    setIsCameraActive(false);
    setIsRequestingCamera(false);
    setNeedsPlayTap(false);
    setMatchedTeacherInFrame(null);
    setHasFaceInFrame(false);
  };

  const switchCamera = () => {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    setMirrorPreview(nextMode === 'user');
    if (isCameraActive) {
      void startCamera(nextMode);
    }
  };

  const handleAttendanceSubmit = async (actionType: 'checkIn' | 'checkOut') => {
    await submitAttendanceDirect(actionType);
  };

  const handleSavePermit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await gasPost('teacherAttendance', {
        actionType: 'permit',
        sessionId: permitSessionId || activeTeacherSession?.id || undefined,
        teacherId: myTeacher?.id || user?.id,
        teacherName: myTeacher?.name || user?.name,
        teacherNip: myTeacher?.nip || user?.nip || teacherDisplayNip || '',
        teacherEmail: myTeacher?.email || user?.email || '',
        userId: user?.id,
        permitType,
        notes: permitNotes,
      });

      if (res.success) {
        playSuccessChime();
        setShowPermitModal(false);
        setPermitNotes('');
        setFeedback({ type: 'success', message: `Pengajuan ${permitType} berhasil disimpan.` });
        await notifyFaceDatabaseChanged();
        await loadTeacherHistory();
      } else {
        playErrorBeep();
        setShowPermitModal(false);
        setFeedback({ type: 'error', message: res.error || 'Gagal mengajukan izin.' });
      }
    } catch (err: any) {
      playErrorBeep();
      setShowPermitModal(false);
      setFeedback({ type: 'error', message: err?.message || 'Gagal mengajukan izin.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const sessionFilteredHistory = useMemo(() => {
    if (sessionFilter === 'ALL') return history;
    return history.filter((h) => String(h.sessionId || '') === sessionFilter);
  }, [history, sessionFilter]);

  const prevDateStr = shiftUtcDate(selectedDate, -1);
  const nextDateStr = shiftUtcDate(selectedDate, 1);
  const prevDateRecord = sessionFilteredHistory.find((h) => h.date === prevDateStr);
  const selectedDateRecords = useMemo(
    () => sessionFilteredHistory.filter((h) => h.date === selectedDate),
    [sessionFilteredHistory, selectedDate]
  );
  const selectedDateRecord = selectedDateRecords[0];
  const nextDateRecord = sessionFilteredHistory.find((h) => h.date === nextDateStr);

  const weekBounds = getWeekBounds(selectedDate);
  const selectedMonthPrefix = selectedDate.slice(0, 7);

  const recapRecords = useMemo(() => {
    if (recapMode === 'daily') return sessionFilteredHistory.filter((h) => h.date === selectedDate);
    if (recapMode === 'weekly')
      return sessionFilteredHistory.filter((h) => h.date >= weekBounds.start && h.date <= weekBounds.end);
    if (recapMode === 'monthly')
      return sessionFilteredHistory.filter((h) => h.date.startsWith(selectedMonthPrefix));
    if (recapMode === 'range') {
      const start = rangeStartDate <= rangeEndDate ? rangeStartDate : rangeEndDate;
      const end = rangeStartDate <= rangeEndDate ? rangeEndDate : rangeStartDate;
      return sessionFilteredHistory.filter((h) => h.date >= start && h.date <= end);
    }
    return sessionFilteredHistory;
  }, [
    sessionFilteredHistory,
    recapMode,
    selectedDate,
    weekBounds.start,
    weekBounds.end,
    selectedMonthPrefix,
    rangeStartDate,
    rangeEndDate,
  ]);

  const recapStats = useMemo(() => {
    const tepatWaktu = recapRecords.filter((r) => r.status === 'Tepat Waktu').length;
    const terlambat = recapRecords.filter((r) => r.status === 'Terlambat').length;
    const izin = recapRecords.filter((r) => r.status === 'Izin').length;
    const sakit = recapRecords.filter((r) => r.status === 'Sakit').length;
    return { tepatWaktu, terlambat, izin, sakit, total: recapRecords.length };
  }, [recapRecords]);

  const handleStepRecap = (direction: -1 | 1) => {
    if (recapMode === 'weekly') {
      setSelectedDate((prev) => shiftUtcDate(prev, direction * 7));
    } else if (recapMode === 'monthly') {
      setSelectedDate((prev) => shiftMonthDate(prev, direction));
    } else {
      setSelectedDate((prev) => shiftUtcDate(prev, direction));
    }
  };

  const handleExportPersonalRecap = () => {
    const wb = XLSX.utils.book_new();
    const rows = recapRecords.map((r, idx) => ({
      No: idx + 1,
      Tanggal: r.date,
      Sesi: r.sessionName || '-',
      Nama_Guru: (r as any).teacherName || teacherDisplayName || user?.name || 'Guru',
      NIP: r.nip || teacherDisplayNip || '-',
      Jam_Masuk: r.timeIn || '-',
      Jam_Pulang: r.timeOut || '-',
      Status: r.status,
      Metode: r.method,
      Catatan: r.notes || '-',
    }));
    const ws = XLSX.utils.json_to_sheet(
      rows.length > 0 ? rows : [{ Info: `Tidak ada data presensi pada rentang yang dipilih (${selectedDate})` }]
    );
    XLSX.utils.book_append_sheet(wb, ws, 'Rekap_Presensi_Guru');
    XLSX.writeFile(
      wb,
      `Rekap_Presensi_${(teacherDisplayName || user?.name || 'Guru').replace(/\s+/g, '_')}_${selectedDate}.xlsx`
    );
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
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
          <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xl shadow-md shadow-indigo-500/20">
            <Briefcase className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                Ruang Kerja Guru: {myTeacher?.name || teacherDisplayName || user?.name || 'Guru'}
              </h1>
              <span
                className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                  myFaceTemplate
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800'
                    : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
                }`}
              >
                {myFaceTemplate ? 'Wajah Biometrik Terdaftar' : 'Wajah Belum Terdaftar di DB'}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              NIP: <strong className="font-mono">{myTeacher?.nip || user?.nip || teacherDisplayNip || '-'}</strong>
              {(myTeacher?.subject || user?.subject) ? ` • ${myTeacher?.subject || user?.subject}` : ''} • Validasi Wajah & GPS
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-xs font-black text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-indigo-500" />
            <span>{liveClock24} WIB</span>
          </div>
          <button
            onClick={() => setShowPermitModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 transition"
          >
            <FileText className="w-4 h-4" />
            <span>Ajukan Izin / Sakit</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 space-y-6">
          {/* GPS Card */}
          <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Navigation className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Lokasi Presensi GPS</h3>
              </div>
              <button
                onClick={requestLocation}
                disabled={gpsLoading}
                className="p-1.5 text-slate-400 hover:text-blue-600 rounded-lg transition"
                title="Perbarui GPS"
              >
                <RefreshCw className={`w-4 h-4 ${gpsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {gpsLoading ? (
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 flex items-center gap-3">
                <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
                <span>Mendeteksi koordinat GPS perangkat Anda...</span>
              </div>
            ) : gpsError ? (
              <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                {gpsError}
              </div>
            ) : (
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Titik Sekolah Terdekat:</span>
                  <span className="font-bold text-slate-900 dark:text-white">
                    {nearestLocation?.location.name || 'Kampus Sekolah'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Jarak Saat Ini:</span>
                  <span className="font-mono font-bold text-slate-900 dark:text-white">
                    {nearestLocation?.distanceMeters ?? '-'} meter
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-slate-200 dark:border-slate-700">
                  <span className="text-slate-500">Status Radius (Maks {nearestLocation?.location.radiusMeters}m):</span>
                  <span
                    className={`font-bold px-2 py-0.5 rounded-md text-[10px] ${
                      isInsideRadius
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
                    }`}
                  >
                    {isInsideRadius ? 'Di Dalam Radius (Valid)' : 'Di Luar Radius (Ditolak)'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Camera Card (Instant Open + Auto-Presensi Sesuai Sesi saat Wajah Cocok) */}
          <div className="relative rounded-3xl overflow-hidden bg-slate-900 border border-slate-800 shadow-xl min-h-[340px] flex flex-col items-center justify-center p-4 sm:p-5 text-center space-y-3">
            {/* Session Indicator (Automatic 24h Switch & Strict Per-Session Sheet Isolation) */}
            <div className="w-full flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="inline-flex flex-wrap items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 text-slate-100 font-bold border border-slate-700 text-left">
                <Clock className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <span>
                  {!activeTeacherSession
                    ? nextTeacherSession
                      ? `Di Luar Jam Sesi • Berikutnya: ${nextTeacherSession.name} (${nextTeacherSession.startTime}–${nextTeacherSession.endTime} WIB)`
                      : `Di Luar Jadwal Sesi Guru (${wibNowHhMm} WIB)`
                    : activeAutoSession === 'checkIn'
                      ? `Sesi ${activeTeacherSession.name} (${activeTeacherSession.startTime}–${activeTeacherSession.endTime} WIB • Batas ${activeTeacherSession.lateCutoffTime} WIB) • Auto Masuk`
                      : activeAutoSession === 'checkOut'
                        ? `Sesi ${activeTeacherSession.name}: Auto Pulang Aktif`
                        : activeAutoSession === 'waitingCheckOut'
                          ? `${activeTeacherSession.name}: Sudah Masuk (${todayRecord?.timeIn} WIB) • Pulang ${checkOutTime} WIB`
                          : `Sesi ${activeTeacherSession.name}: Presensi Selesai`}
                </span>
              </div>

              {activeTeacherSession && (
                <span className="px-2.5 py-1 rounded-lg bg-slate-800/90 text-emerald-300 border border-slate-700 font-mono text-[10px] font-bold">
                  Sheet: {activeTeacherSession.sheetName}
                </span>
              )}

              {activeAutoSession === 'waitingCheckOut' && (
                <button
                  type="button"
                  onClick={() => setEarlyCheckoutAutoEnabled(true)}
                  className="px-3 py-1.5 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 text-[11px] font-bold transition"
                >
                  Aktifkan Auto-Pulang Sekarang
                </button>
              )}
            </div>

            {isCameraActive && (
              <div className="relative w-full mx-auto rounded-2xl overflow-hidden bg-slate-950 border border-slate-800">
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
                  maxHeightClass="h-[52dvh] min-h-[340px] max-h-[580px] sm:h-[460px] lg:h-[520px]"
                  onVideoDimensions={(w, h) => setVideoAspect(w / h)}
                >
                  {matchedTeacherInFrame && (
                    <div className="absolute bottom-3 left-3 right-3 p-2.5 rounded-xl bg-emerald-600/95 backdrop-blur-md text-white text-left flex items-center justify-between gap-2 shadow-lg border border-emerald-300/50">
                      <div className="flex items-center gap-2 min-w-0">
                        <UserCheck className="w-4 h-4 flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold uppercase text-emerald-100">Wajah Cocok</div>
                          <div className="text-xs font-black truncate">{matchedTeacherInFrame.name}</div>
                        </div>
                      </div>
                      <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-white/20 flex-shrink-0">
                        {isSubmitting
                          ? 'Menyimpan...'
                          : activeAutoSession === 'checkIn'
                          ? 'Auto Masuk'
                          : activeAutoSession === 'checkOut'
                          ? 'Auto Pulang'
                          : 'Terverifikasi'}
                      </span>
                    </div>
                  )}

                  {hasFaceInFrame && !matchedTeacherInFrame && (
                    <div className="absolute bottom-3 left-3 right-3 px-3 py-1.5 rounded-xl bg-amber-500/90 text-white text-[11px] font-bold">
                      Wajah terdeteksi — tidak cocok dengan database wajah guru
                    </div>
                  )}
                </CameraPreviewStage>
              </div>
            )}

            {!isCameraActive && (
              <div className="space-y-4 max-w-sm py-4">
                <div className="w-16 h-16 mx-auto rounded-2xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center">
                  <Camera className={`w-8 h-8 ${isRequestingCamera ? 'animate-pulse' : ''}`} />
                </div>
                <div className="space-y-1">
                  <h4 className="text-base font-bold text-white">
                    {isRequestingCamera ? 'Meminta Izin Pengaktifan Kamera...' : 'Kamera Verifikasi Wajah'}
                  </h4>
                  <p className="text-xs text-slate-400">
                    {isRequestingCamera
                      ? 'Silakan klik "Izinkan / Allow" pada dialog browser untuk menyalakan kamera.'
                      : 'Kamera mencocokkan wajah dengan database wajah guru (kanan di kanan, kiri di kiri) dan langsung memproses presensi sesuai sesi.'}
                  </p>
                </div>

                {cameraError && (
                  <div className="p-3 rounded-xl bg-red-950 border border-red-800 text-xs text-red-300 text-left space-y-1">
                    <div className="font-bold text-red-200">{cameraError.title}</div>
                    <div>{cameraError.message}</div>
                  </div>
                )}

                <button
                  onClick={() => void startCamera()}
                  className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow flex items-center gap-2 mx-auto"
                >
                  <Camera className="w-4 h-4" />
                  <span>{cameraError ? 'Coba Lagi' : isRequestingCamera ? 'Minta Ulang Izin Kamera' : 'Aktifkan Kamera'}</span>
                </button>
              </div>
            )}

            {isCameraActive && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <span className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-200 text-[11px] font-medium flex items-center gap-1.5 border border-slate-700">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      modelStatus === 'ready' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'
                    }`}
                  />
                  {modelStatus === 'ready' ? 'AI Wajah Siap • Auto Presensi Aktif' : 'Menyiapkan AI...'}
                </span>
                <button
                  type="button"
                  onClick={() => setMirrorPreview((v) => !v)}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition border border-slate-700"
                  title="Sesuaikan orientasi tampilan preview (AI tetap memakai gambar asli)"
                >
                  {mirrorPreview ? 'Orientasi: Kanan=Kanan' : 'Orientasi: Sensor Asli'}
                </button>
                <button
                  type="button"
                  onClick={switchCamera}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition flex items-center gap-1.5 border border-slate-700"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Ganti Kamera</span>
                </button>
                <button
                  type="button"
                  onClick={stopCamera}
                  className="px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition"
                >
                  Tutup Kamera
                </button>
              </div>
            )}

            <div className="text-[11px] text-emerald-400 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Privasi terjaga: tidak ada foto yang disimpan ke server.</span>
            </div>
          </div>

          {feedback && (
            <div
              className={`p-4 rounded-2xl border text-xs flex items-center gap-3 ${
                feedback.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100'
                  : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-100'
              }`}
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-500 flex-shrink-0" />
              )}
              <span>{feedback.message}</span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={() => void handleAttendanceSubmit('checkIn')}
              disabled={!activeTeacherSession || isSubmitting || Boolean(todayRecord && todayRecord.timeIn)}
              className="py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-lg shadow-emerald-600/20 disabled:opacity-50 transition text-center"
            >
              <div className="text-base">Presensi Masuk</div>
              <div className="text-[11px] font-normal opacity-80 mt-0.5">
                {!activeTeacherSession
                  ? 'Di luar jam sesi guru'
                  : todayRecord?.timeIn
                    ? `Sudah Masuk (${todayRecord.timeIn} WIB)`
                    : `Sesi ${activeTeacherSession.name}`}
              </div>
            </button>

            <button
              onClick={() => void handleAttendanceSubmit('checkOut')}
              disabled={!activeTeacherSession || isSubmitting || !todayRecord || Boolean(todayRecord?.timeOut)}
              className="py-4 px-6 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm shadow-lg shadow-blue-600/20 disabled:opacity-50 transition text-center"
            >
              <div className="text-base">Presensi Pulang</div>
              <div className="text-[11px] font-normal opacity-80 mt-0.5">
                {!activeTeacherSession
                  ? 'Di luar jam sesi guru'
                  : todayRecord?.timeOut
                    ? `Sudah Pulang (${todayRecord.timeOut} WIB)`
                    : 'Klik saat jam pulang'}
              </div>
            </button>
          </div>
        </div>

        {/* Right Column: Recap & History */}
        <div className="lg:col-span-5 p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-indigo-500" />
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Cek Tanggal & Rekap Presensi</h3>
                {teacherDisplayName && <p className="text-[11px] text-slate-400">Guru: {teacherDisplayName}</p>}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {teacherSessions.length > 0 && (
                <select
                  value={sessionFilter}
                  onChange={(e) => setSessionFilter(e.target.value)}
                  className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                >
                  <option value="ALL">Semua Sesi</option>
                  {teacherSessions.map((ses) => (
                    <option key={ses.id} value={ses.id}>
                      {ses.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={handleExportPersonalRecap}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Ekspor</span>
              </button>
            </div>
          </div>

          <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700 space-y-2.5">
            <div className="flex items-center justify-between gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedDate((prev) => shiftUtcDate(prev, -1))}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 transition"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Sebelum</span>
              </button>

              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                <Calendar className="w-3.5 h-3.5 text-indigo-500" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                  className="text-xs font-bold bg-transparent text-slate-900 dark:text-white focus:outline-none"
                />
              </div>

              <button
                type="button"
                onClick={() => setSelectedDate((prev) => shiftUtcDate(prev, 1))}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 transition"
              >
                <span>Sesudah</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {selectedDate !== todayStr && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setSelectedDate(todayStr)}
                  className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Kembali ke Hari Ini ({todayStr})
                </button>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 pt-1">
              {[
                { label: 'Sebelum', date: prevDateStr, record: prevDateRecord, isCenter: false },
                { label: 'Dipilih', date: selectedDate, record: selectedDateRecord, isCenter: true },
                { label: 'Sesudah', date: nextDateStr, record: nextDateRecord, isCenter: false },
              ].map((slot) => (
                <button
                  key={slot.label}
                  type="button"
                  onClick={() => setSelectedDate(slot.date)}
                  className={`p-2.5 rounded-xl text-left border transition ${
                    slot.isCenter
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:border-indigo-400 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  <div className={`text-[10px] font-bold uppercase ${slot.isCenter ? 'text-indigo-100' : 'text-slate-400'}`}>
                    {slot.label}
                  </div>
                  <div className="text-[11px] font-bold truncate mt-0.5">{slot.date.slice(5)}</div>
                  <div
                    className={`mt-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded inline-block truncate max-w-full ${
                      slot.record
                        ? slot.isCenter
                          ? 'bg-white/20 text-white'
                          : slot.record.status === 'Tepat Waktu'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                          : slot.record.status === 'Terlambat'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                        : slot.isCenter
                        ? 'bg-white/10 text-indigo-100'
                        : 'bg-slate-100 text-slate-400 dark:bg-slate-800'
                    }`}
                  >
                    {slot.record ? slot.record.status : 'Kosong'}
                  </div>
                  <div className={`text-[10px] mt-1 font-mono ${slot.isCenter ? 'text-indigo-100' : 'text-slate-400'}`}>
                    {slot.record ? `${slot.record.timeIn || '-'} / ${slot.record.timeOut || '-'}` : '-'}
                  </div>
                </button>
              ))}
            </div>

            <div className="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[11px] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-800 dark:text-slate-100">
                  Detail {formatIndoShort(selectedDate)}
                </span>
                <span className="text-[10px] font-semibold text-slate-400">
                  {selectedDateRecords.length} Sesi Tercatat
                </span>
              </div>
              {selectedDateRecords.length > 0 ? (
                <div className="space-y-1.5">
                  {selectedDateRecords.map((rec) => (
                    <div
                      key={rec.id}
                      className="p-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-indigo-600 dark:text-indigo-400">
                          {rec.sessionName || 'Sesi Guru'}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${
                            rec.status === 'Tepat Waktu'
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                              : rec.status === 'Terlambat'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                                : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                          }`}
                        >
                          {rec.status}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-500">
                        <span>
                          Masuk: <strong className="font-mono text-slate-800 dark:text-slate-200">{rec.timeIn || '-'}</strong>
                        </span>
                        <span>
                          Pulang: <strong className="font-mono text-slate-800 dark:text-slate-200">{rec.timeOut || '-'}</strong>
                        </span>
                      </div>
                      {rec.notes && <div className="text-slate-400 italic">Catatan: {rec.notes}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-slate-400">Belum ada catatan masuk/izin pada tanggal ini.</div>
              )}
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex flex-wrap p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                {[
                  { id: 'daily', label: 'Harian' },
                  { id: 'weekly', label: 'Pekan' },
                  { id: 'monthly', label: 'Bulanan' },
                  { id: 'range', label: 'Rentang' },
                  { id: 'all', label: 'Semua' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setRecapMode(tab.id as any)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${
                      recapMode === tab.id
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {recapMode !== 'all' && recapMode !== 'range' && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleStepRecap(-1)}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStepRecap(1)}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {recapMode === 'range' && (
              <div className="grid grid-cols-2 gap-2 p-2.5 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800">
                <div>
                  <label className="text-[10px] font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1 mb-1">
                    <Filter className="w-3 h-3" /> Dari Tanggal
                  </label>
                  <input
                    type="date"
                    value={rangeStartDate}
                    onChange={(e) => e.target.value && setRangeStartDate(e.target.value)}
                    className="w-full px-2 py-1 text-xs font-semibold rounded-lg bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-700 text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-indigo-700 dark:text-indigo-300 block mb-1">
                    Sampai Tanggal
                  </label>
                  <input
                    type="date"
                    value={rangeEndDate}
                    onChange={(e) => e.target.value && setRangeEndDate(e.target.value)}
                    className="w-full px-2 py-1 text-xs font-semibold rounded-lg bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-700 text-slate-900 dark:text-white"
                  />
                </div>
              </div>
            )}

            <div className="text-[11px] text-slate-500 flex items-center justify-between">
              <span>
                {recapMode === 'daily'
                  ? `Tanggal ${formatIndoShort(selectedDate)}`
                  : recapMode === 'weekly'
                  ? `Pekan: ${weekBounds.start} s/d ${weekBounds.end}`
                  : recapMode === 'monthly'
                  ? `Bulan: ${selectedMonthPrefix}`
                  : recapMode === 'range'
                  ? `Rentang: ${rangeStartDate} s/d ${rangeEndDate}`
                  : 'Seluruh Riwayat Tersimpan'}
              </span>
              <span className="font-semibold text-slate-400">{recapStats.total} Catatan</span>
            </div>

            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/70 dark:border-emerald-900">
                <div className="text-sm font-black text-emerald-700 dark:text-emerald-300">{recapStats.tepatWaktu}</div>
                <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">Tepat</div>
              </div>
              <div className="p-2 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-900">
                <div className="text-sm font-black text-amber-700 dark:text-amber-300">{recapStats.terlambat}</div>
                <div className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">Telat</div>
              </div>
              <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200/70 dark:border-blue-900">
                <div className="text-sm font-black text-blue-700 dark:text-blue-300">{recapStats.izin}</div>
                <div className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">Izin</div>
              </div>
              <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200/70 dark:border-purple-900">
                <div className="text-sm font-black text-purple-700 dark:text-purple-300">{recapStats.sakit}</div>
                <div className="text-[10px] font-semibold text-purple-600 dark:text-purple-400">Sakit</div>
              </div>
            </div>
          </div>

          <div className="space-y-2 max-h-[290px] overflow-y-auto pr-1">
            {recapRecords.length === 0 ? (
              <div className="py-8 text-center text-slate-400 text-xs">
                Belum ada catatan presensi pada rentang yang dipilih.
              </div>
            ) : (
              recapRecords.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedDate(item.date)}
                  className={`w-full text-left p-3 rounded-2xl border space-y-1 text-xs transition ${
                    item.date === selectedDate
                      ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700'
                      : 'bg-slate-50 dark:bg-slate-800/60 border-slate-100 dark:border-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-slate-900 dark:text-white">{formatIndoShort(item.date)}</span>
                      {item.sessionName && (
                        <span className="px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold">
                          {item.sessionName}
                        </span>
                      )}
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${
                        item.status === 'Tepat Waktu'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                          : item.status === 'Terlambat'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-500 text-[11px]">
                    <span>Masuk: {item.timeIn || '-'}</span>
                    <span>Pulang: {item.timeOut || '-'}</span>
                  </div>
                  {item.notes && (
                    <div className="text-[11px] text-slate-400 italic pt-1 border-t border-slate-200/50 dark:border-slate-700/50">
                      {item.notes}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {showPermitModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Pengajuan Izin / Sakit Guru</h3>
            <p className="text-xs text-slate-500 mb-4">
              Pengajuan akan langsung tercatat ke Sheet sesi guru yang dipilih dengan nama & NIP Anda.
            </p>

            <form onSubmit={handleSavePermit} className="space-y-4">
              {teacherSessions.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Pilih Sesi Guru (24 Jam WIB)
                  </label>
                  <select
                    value={permitSessionId}
                    onChange={(e) => setPermitSessionId(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    {teacherSessions.map((ses) => (
                      <option key={ses.id} value={ses.id}>
                        {ses.name} ({ses.startTime}–{ses.endTime} WIB)
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Jenis Pengajuan
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setPermitType('Izin')}
                    className={`py-2 text-xs font-bold rounded-xl border transition ${
                      permitType === 'Izin'
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    Izin Keperluan
                  </button>
                  <button
                    type="button"
                    onClick={() => setPermitType('Sakit')}
                    className={`py-2 text-xs font-bold rounded-xl border transition ${
                      permitType === 'Sakit'
                        ? 'bg-purple-600 text-white border-purple-600'
                        : 'bg-slate-50 dark:bg-slate-800 border-slate-200 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    Sakit
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Keterangan / Alasan
                </label>
                <textarea
                  value={permitNotes}
                  onChange={(e) => setPermitNotes(e.target.value)}
                  placeholder="Keterangan pengajuan..."
                  rows={3}
                  className="w-full p-3 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowPermitModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow"
                >
                  {isSubmitting ? 'Mengirim...' : 'Kirim Pengajuan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
