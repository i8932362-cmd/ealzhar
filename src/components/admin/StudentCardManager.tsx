import React, { useState, useRef, useEffect } from 'react';
import { toJpeg } from 'html-to-image';
import JSZip from 'jszip';
import {
  Download,
  Printer,
  Search,
  Filter,
  Eye,
  Settings as SettingsIcon,
  CheckCircle2,
  AlertCircle,
  FileArchive,
  Layers,
  Sparkles,
  School,
  UserCheck,
  ChevronRight,
  RefreshCw,
  Sliders,
  Upload,
  Globe,
  MapPin,
  QrCode,
  Image as ImageIcon,
  PenTool,
  Trash2,
  Loader2,
} from 'lucide-react';
import { Student, SchoolClass, EducationLevel, LevelConfig, FaceTemplate, SchoolSettings } from '../../types/index.ts';
import {
  StudentCardFront,
  StudentCardBack,
  DEFAULT_LEVEL_CONFIGS,
  ResolvedCardAssetOverrides,
  getStudentInitialAvatarDataUrl,
  getFallbackQrSvgDataUrl,
} from './StudentCardTemplate.tsx';
import {
  uploadImageAssetToDrive,
  deleteImageAssetFromDrive,
  extractDriveFileId,
  fetchDrivePhotoDataUrl,
  fetchExternalImageAsDataUrl,
} from '../../lib/api.ts';
import { emitActionToast } from '../../lib/toast.ts';
import { DriveImage, preloadDriveImageUrls } from '../common/DriveImage.tsx';

interface StudentCardManagerProps {
  students: Student[];
  classes: SchoolClass[];
  schoolName: string;
  schoolAddress?: string;
  schoolLogo?: string;
  foundationWebsite?: string;
  watermarkUrl?: string;
  faceTemplates?: FaceTemplate[];
  onUpdateSettings?: (newSettings: Partial<SchoolSettings>) => Promise<boolean>;
  onSavedToast?: (msg: string) => void;
  initialLevelConfigsJson?: string;
}

function parseLevelConfigsSafely(raw?: string): Record<string, Partial<LevelConfig>> | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, Partial<LevelConfig>>;
  } catch {
    return null;
  }
}

function mergeWithDefaultLevelConfigs(
  parsed?: Record<string, Partial<LevelConfig>> | null
): Record<EducationLevel, LevelConfig> {
  const result: Record<EducationLevel, LevelConfig> = {
    SMK: { ...DEFAULT_LEVEL_CONFIGS['SMK'] },
    'SMP/MTS': { ...DEFAULT_LEVEL_CONFIGS['SMP/MTS'] },
    'SD/MI': { ...DEFAULT_LEVEL_CONFIGS['SD/MI'] },
  };
  if (!parsed) return result;

  // Backward-compatible migration: preserve uploaded logo, signature, stamp, watermark & text from legacy SMA/MA key
  const legacySmaMa = parsed['SMA/MA'];
  const currentSmk = parsed['SMK'];
  if ((legacySmaMa && typeof legacySmaMa === 'object') || (currentSmk && typeof currentSmk === 'object')) {
    const mergedSmk: LevelConfig = {
      ...result['SMK'],
      ...(legacySmaMa && typeof legacySmaMa === 'object' ? legacySmaMa : {}),
      ...(currentSmk && typeof currentSmk === 'object' ? currentSmk : {}),
      level: 'SMK',
    };
    const rawUnit = String(mergedSmk.unitName || '').trim().toUpperCase();
    if (!rawUnit || rawUnit === 'SMA / MA MAMBAUL ULUM' || rawUnit === 'SMA/MA' || rawUnit === 'SMA/MA MAMBAUL ULUM') {
      mergedSmk.unitName = DEFAULT_LEVEL_CONFIGS['SMK'].unitName;
    }
    const rawBadge = String(mergedSmk.badgeText || '').trim().toUpperCase();
    if (!rawBadge || rawBadge === 'JENJANG MENENGAH ATAS') {
      mergedSmk.badgeText = DEFAULT_LEVEL_CONFIGS['SMK'].badgeText;
    }
    result['SMK'] = mergedSmk;
  }

  (['SMP/MTS', 'SD/MI'] as EducationLevel[]).forEach((lvl) => {
    if (parsed[lvl] && typeof parsed[lvl] === 'object') {
      result[lvl] = {
        ...result[lvl],
        ...parsed[lvl],
        level: lvl,
      };
    }
  });
  return result;
}

interface ExportRenderTarget {
  student: Student;
  schoolClass?: SchoolClass;
  config: LevelConfig;
  hasFace: boolean;
  assets: ResolvedCardAssetOverrides;
}

function waitNextAnimationFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const step = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => step(remaining - 1));
    };
    step(count);
  });
}

async function waitForImagesInsideElement(container: HTMLElement): Promise<void> {
  const imgs = Array.from(container.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      if (!img.getAttribute('src')) return;
      if (!img.complete || img.naturalWidth === 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            img.removeEventListener('load', finish);
            img.removeEventListener('error', finish);
            resolve();
          };
          img.addEventListener('load', finish);
          img.addEventListener('error', finish);
          setTimeout(finish, 4000);
        });
      }
      if (typeof img.decode === 'function') {
        try {
          await img.decode();
        } catch {
          // Ignore SVG/data decode edge cases when already loaded
        }
      }
    })
  );
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gagal memuat gambar kartu untuk digabung.'));
    img.src = src;
  });
}

async function composeFrontBackCardJpeg(
  frontDataUrl: string,
  backDataUrl: string,
  student: Student,
  classNameStr: string,
  levelLabel: string
): Promise<string> {
  const [frontImg, backImg] = await Promise.all([
    loadHtmlImage(frontDataUrl),
    loadHtmlImage(backDataUrl),
  ]);

  const cardW = 1062;
  const cardH = 680;
  const padX = 56;
  const headerH = 92;
  const gapX = 56;
  const footerH = 44;
  const totalW = padX * 2 + cardW * 2 + gapX;
  const totalH = headerH + cardH + footerH + 24;

  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return frontDataUrl;

  // Clean white printable sheet background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalW, totalH);

  // Header metadata line
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 28px Inter, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`KARTU PELAJAR — ${student.name.toUpperCase()} (${levelLabel})`, padX, 46);

  ctx.fillStyle = '#475569';
  ctx.font = '600 22px monospace';
  const rightMeta = `NISN: ${student.nisn || student.nis}  •  Kelas: ${classNameStr || 'Reguler'}`;
  const metaWidth = ctx.measureText(rightMeta).width;
  ctx.fillText(rightMeta, totalW - padX - metaWidth, 46);

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, headerH - 14);
  ctx.lineTo(totalW - padX, headerH - 14);
  ctx.stroke();

  // Front card (Left) & Back card (Right)
  ctx.drawImage(frontImg, padX, headerH, cardW, cardH);
  ctx.drawImage(backImg, padX + cardW + gapX, headerH, cardW, cardH);

  // Center fold/cut dashed guide
  const centerX = padX + cardW + gapX / 2;
  ctx.save();
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(centerX, headerH);
  ctx.lineTo(centerX, headerH + cardH);
  ctx.stroke();
  ctx.restore();

  // Subtle side captions
  ctx.fillStyle = '#64748b';
  ctx.font = '700 18px Inter, Arial, sans-serif';
  const lblFront = 'SISI DEPAN';
  const lblBack = 'SISI BELAKANG';
  ctx.fillText(lblFront, padX + cardW / 2 - ctx.measureText(lblFront).width / 2, headerH + cardH + 28);
  ctx.fillText(lblBack, padX + cardW + gapX + cardW / 2 - ctx.measureText(lblBack).width / 2, headerH + cardH + 28);

  return canvas.toDataURL('image/jpeg', 0.96);
}

export const StudentCardManager: React.FC<StudentCardManagerProps> = ({
  students,
  classes,
  schoolName,
  schoolAddress,
  schoolLogo,
  foundationWebsite,
  watermarkUrl,
  faceTemplates = [],
  onUpdateSettings,
  onSavedToast,
  initialLevelConfigsJson,
}) => {
  // Filters & State
  const [selectedLevel, setSelectedLevel] = useState<EducationLevel | 'ALL'>('ALL');
  const [selectedClassId, setSelectedClassId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [cardSideView, setCardSideView] = useState<'both' | 'front' | 'back'>('both');

  // Custom Level Configs initialized from props or defaults
  const [levelConfigs, setLevelConfigs] = useState<Record<EducationLevel, LevelConfig>>(() => {
    const parsed = parseLevelConfigsSafely(initialLevelConfigsJson);
    return mergeWithDefaultLevelConfigs(parsed);
  });

  // Track face enrollments
  const enrolledStudentIds = new Set(
    faceTemplates.filter(f => f.personType === 'student').map(f => f.personId)
  );

  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);
  const [activeConfigTab, setActiveConfigTab] = useState<EducationLevel>('SMK');
  const [isSavingConfig, setIsSavingConfig] = useState<boolean>(false);
  const [uploadingField, setUploadingField] = useState<
    'principalSignatureUrl' | 'stampUrl' | 'logoUrl' | 'qrCodeUrl' | 'watermarkUrl' | null
  >(null);
  const [deletingField, setDeletingField] = useState<
    'principalSignatureUrl' | 'stampUrl' | 'logoUrl' | 'qrCodeUrl' | 'watermarkUrl' | null
  >(null);
  const [saveFeedback, setSaveFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const isDirtyRef = useRef<boolean>(false);

  // Export states (dedicated offscreen stage ensures both sides & all Drive assets always render before capture)
  const [exportRenderTarget, setExportRenderTarget] = useState<ExportRenderTarget | null>(null);
  const [exportingStudentKey, setExportingStudentKey] = useState<string | null>(null);
  const [isExportingBatch, setIsExportingBatch] = useState<boolean>(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; studentName: string } | null>(null);
  const [downloadSuccessMessage, setDownloadSuccessMessage] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  // Sync initialLevelConfigsJson when changed from parent (only if admin is not actively editing)
  useEffect(() => {
    if (showConfigModal || isDirtyRef.current) return;
    const parsed = parseLevelConfigsSafely(initialLevelConfigsJson);
    if (parsed) {
      setLevelConfigs(mergeWithDefaultLevelConfigs(parsed));
    }
  }, [initialLevelConfigsJson, showConfigModal]);

  // Preload shared Drive assets (logo, TTD, stamp, watermark, QR) for crisp preview & fast downloads
  useEffect(() => {
    const urls: Array<string | undefined> = [schoolLogo, watermarkUrl];
    (['SMK', 'SMP/MTS', 'SD/MI'] as EducationLevel[]).forEach((lvl) => {
      const c = levelConfigs[lvl];
      if (c) urls.push(c.logoUrl, c.principalSignatureUrl, c.stampUrl, c.watermarkUrl, c.qrCodeUrl);
    });
    void preloadDriveImageUrls(urls);
  }, [levelConfigs, schoolLogo, watermarkUrl]);

  const updateLevelConfigs = (
    updater:
      | Record<EducationLevel, LevelConfig>
      | ((prev: Record<EducationLevel, LevelConfig>) => Record<EducationLevel, LevelConfig>)
  ) => {
    isDirtyRef.current = true;
    setSaveFeedback(null);
    setLevelConfigs(updater);
  };

  // Helper to normalize and automatically detect education level configured by Admin
  const normalizeLevelValue = (raw?: string): EducationLevel | null => {
    const up = String(raw || '').toUpperCase().replace(/\s+/g, '');
    if (!up) return null;
    if (up === 'SD/MI' || up === 'SD' || up === 'MI' || up.startsWith('SD') || up.startsWith('MI')) return 'SD/MI';
    if (up === 'SMP/MTS' || up === 'SMP' || up === 'MTS' || up.startsWith('SMP') || up.startsWith('MTS')) return 'SMP/MTS';
    if (up === 'SMK' || up === 'SMA/MA' || up === 'SMA' || up === 'MA' || up.startsWith('SMK') || up.startsWith('SMA') || up.startsWith('MA')) return 'SMK';
    return null;
  };

  const getClassLevel = (cls?: SchoolClass): EducationLevel => {
    if (!cls) return 'SMK';
    const explicit = normalizeLevelValue(cls.level);
    if (explicit) return explicit;
    const gradeNum = Number(String(cls.grade || '').replace(/[^0-9]/g, ''));
    if (!Number.isNaN(gradeNum) && gradeNum >= 1 && gradeNum <= 12) {
      if (gradeNum <= 6) return 'SD/MI';
      if (gradeNum <= 9) return 'SMP/MTS';
      return 'SMK';
    }
    const name = (cls.name || '').toUpperCase().trim();
    if (/\b(SMK|SMA|MA|XII|XI|X|12|11|10)\b/.test(name)) return 'SMK';
    if (/\b(SMP|MTS|IX|VIII|VII|9|8|7)\b/.test(name)) return 'SMP/MTS';
    if (/\b(SD|MI|VI|V|IV|III|II|I|6|5|4|3|2|1)\b/.test(name)) return 'SD/MI';
    return 'SMK';
  };

  const getStudentLevel = (student: Student): EducationLevel => {
    const explicitStdLevel = normalizeLevelValue(student.level);
    if (explicitStdLevel) return explicitStdLevel;
    const cls = classes.find(c => c.id === student.classId);
    return getClassLevel(cls);
  };

  const activeStudents = students.filter(s => s.isActive);
  const levelCounts: Record<'ALL' | EducationLevel, number> = {
    ALL: activeStudents.length,
    SMK: activeStudents.filter(s => getStudentLevel(s) === 'SMK').length,
    'SMP/MTS': activeStudents.filter(s => getStudentLevel(s) === 'SMP/MTS').length,
    'SD/MI': activeStudents.filter(s => getStudentLevel(s) === 'SD/MI').length,
  };

  const hasManualLevelRef = useRef<boolean>(false);
  const activeLevelsPresent = (['SMK', 'SMP/MTS', 'SD/MI'] as EducationLevel[]).filter(
    lvl => levelCounts[lvl] > 0
  );
  const dominantLevel: EducationLevel =
    (['SMK', 'SMP/MTS', 'SD/MI'] as EducationLevel[]).reduce((best, cur) =>
      levelCounts[cur] > levelCounts[best] ? cur : best
    , 'SMK');

  useEffect(() => {
    if (hasManualLevelRef.current || activeStudents.length === 0) return;
    if (activeLevelsPresent.length === 1) {
      setSelectedLevel(activeLevelsPresent[0]);
      setActiveConfigTab(activeLevelsPresent[0]);
    } else {
      setSelectedLevel('ALL');
      setActiveConfigTab(dominantLevel);
    }
  }, [activeStudents.length, levelCounts['SMK'], levelCounts['SMP/MTS'], levelCounts['SD/MI']]);

  // Filter students
  const filteredStudents = activeStudents.filter(std => {
    const stdLevel = getStudentLevel(std);
    if (selectedLevel !== 'ALL' && stdLevel !== selectedLevel) return false;
    if (selectedClassId !== 'ALL' && std.classId !== selectedClassId) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = std.name.toLowerCase().includes(q);
      const matchNis = std.nis.toLowerCase().includes(q);
      const matchNisn = (std.nisn || '').toLowerCase().includes(q);
      if (!matchName && !matchNis && !matchNisn) return false;
    }
    return true;
  });

  // Filtered classes based on selectedLevel
  const availableClasses = classes.filter(c => {
    if (selectedLevel === 'ALL') return true;
    return getClassLevel(c) === selectedLevel;
  });

  // Handle Image File Upload Helper -> Direct upload to Google Drive Folder
  const handleFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    field: 'principalSignatureUrl' | 'stampUrl' | 'logoUrl' | 'qrCodeUrl' | 'watermarkUrl'
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      const errMsg = 'Ukuran file maksimal 10 MB.';
      setCardError(errMsg);
      setSaveFeedback({ type: 'error', text: errMsg });
      return;
    }

    const purposeMap: Record<typeof field, 'signature' | 'stamp' | 'logo' | 'qr' | 'watermark'> = {
      principalSignatureUrl: 'signature',
      stampUrl: 'stamp',
      logoUrl: 'logo',
      qrCodeUrl: 'qr',
      watermarkUrl: 'watermark',
    };
    const labelMap: Record<typeof field, string> = {
      principalSignatureUrl: 'Tanda Tangan',
      stampUrl: 'Stempel Sekolah',
      logoUrl: 'Logo Sekolah',
      qrCodeUrl: 'QR Code',
      watermarkUrl: 'Watermark Kartu',
    };

    setCardError(null);
    setSaveFeedback(null);
    setUploadingField(field);

    try {
      const levelSlug = activeConfigTab.replace('/', '_');
      const previousUrl = levelConfigs[activeConfigTab]?.[field];
      const uploaded = await uploadImageAssetToDrive(file, {
        purpose: purposeMap[field],
        fileName: `Kartu_${levelSlug}_${purposeMap[field]}`,
        previousUrl,
        trashPrevious: false,
      });

      const activeUpdates: Partial<LevelConfig> = {
        [field]: uploaded.photoUrl,
      };
      // Automatically remove the hardcoded green seal when signature is replaced or custom stamp is uploaded
      if (field === 'principalSignatureUrl' || field === 'stampUrl') {
        activeUpdates.hideStamp = true;
      }

      const nextConfigs: Record<EducationLevel, LevelConfig> = {
        ...levelConfigs,
        [activeConfigTab]: {
          ...levelConfigs[activeConfigTab],
          ...activeUpdates,
        },
      };
      updateLevelConfigs(nextConfigs);

      if (onUpdateSettings) {
        const savedOk = await onUpdateSettings({
          levelConfigsJson: JSON.stringify(nextConfigs),
        });
        if (savedOk) {
          isDirtyRef.current = false;
          const msg = `${labelMap[field]} (${activeConfigTab}) tersimpan ke Google Drive folder "${uploaded.folderName || '04_Logo_TTD_dan_Aset_Kartu'}"!`;
          setSaveFeedback({ type: 'success', text: msg });
          emitActionToast({ type: 'saved', message: msg });
          onSavedToast?.(msg);
          return;
        }
      }
      const msg = `${labelMap[field]} diunggah ke Google Drive. Klik Simpan untuk menerapkan.`;
      setSaveFeedback({ type: 'success', text: msg });
    } catch (err: any) {
      const errMsg = err?.message || `Gagal mengunggah ${labelMap[field]} ke Google Drive.`;
      setSaveFeedback({ type: 'error', text: errMsg });
      emitActionToast({ type: 'error', message: errMsg });
    } finally {
      setUploadingField(null);
    }
  };

  // Delete card image asset cleanly from BOTH Google Drive and Google Sheets
  const handleDeleteAssetField = async (
    field: 'principalSignatureUrl' | 'stampUrl' | 'logoUrl' | 'qrCodeUrl' | 'watermarkUrl',
    label: string
  ) => {
    const currentUrl = levelConfigs[activeConfigTab]?.[field];
    if (!currentUrl) return;
    setDeletingField(field);
    setSaveFeedback(null);
    try {
      if (extractDriveFileId(currentUrl)) {
        const deleted = await deleteImageAssetFromDrive(currentUrl);
        if (!deleted) {
          throw new Error(`Gagal menghapus file ${label} dari Google Drive.`);
        }
      }

      const activeUpdates: Partial<LevelConfig> = {
        [field]: undefined,
      };
      if (field === 'stampUrl') {
        activeUpdates.hideStamp = true;
      }

      const nextConfigs: Record<EducationLevel, LevelConfig> = {
        ...levelConfigs,
        [activeConfigTab]: {
          ...levelConfigs[activeConfigTab],
          ...activeUpdates,
        },
      };
      updateLevelConfigs(nextConfigs);

      if (onUpdateSettings) {
        const ok = await onUpdateSettings({
          levelConfigsJson: JSON.stringify(nextConfigs),
        });
        if (!ok) {
          throw new Error(`Gagal memperbarui Google Sheets setelah menghapus ${label}.`);
        }
        isDirtyRef.current = false;
      }

      const msg = `${label} (${activeConfigTab}) berhasil dihapus bersih dari Google Drive & Sheets.`;
      setSaveFeedback({ type: 'success', text: msg });
      emitActionToast({ type: 'deleted', message: msg });
    } catch (err: any) {
      const errMsg = err?.message || `Gagal menghapus ${label}.`;
      setSaveFeedback({ type: 'error', text: errMsg });
      emitActionToast({ type: 'error', message: errMsg });
    } finally {
      setDeletingField(null);
    }
  };

  // Save Configs to server & local state
  const handleSaveConfigs = async () => {
    if (isSavingConfig) return;
    setIsSavingConfig(true);
    setSaveFeedback(null);
    try {
      if (onUpdateSettings) {
        const success = await onUpdateSettings({
          levelConfigsJson: JSON.stringify(levelConfigs),
        });
        if (success) {
          isDirtyRef.current = false;
          const msg = 'Pengaturan kartu pelajar & gambar tersimpan di Google Sheets & Drive!';
          setSaveFeedback({ type: 'success', text: msg });
          emitActionToast({ type: 'saved', message: msg });
          onSavedToast?.(msg);
          setTimeout(() => {
            setSaveFeedback(null);
            setShowConfigModal(false);
          }, 700);
          return;
        }
        const errText = 'Gagal menyimpan pengaturan kartu ke Google Sheets.';
        setSaveFeedback({ type: 'error', text: errText });
        emitActionToast({ type: 'error', message: errText });
        return;
      }
      isDirtyRef.current = false;
      const localMsg = 'Tersimpan di sesi browser!';
      setSaveFeedback({ type: 'success', text: localMsg });
      emitActionToast({ type: 'saved', message: localMsg });
      setTimeout(() => {
        setSaveFeedback(null);
        setShowConfigModal(false);
      }, 700);
    } catch (err: any) {
      const errText = err?.message || 'Gagal menyimpan pengaturan kartu ke Google Sheets.';
      setSaveFeedback({ type: 'error', text: errText });
      emitActionToast({ type: 'error', message: errText });
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Resolve any asset reference (gas-photo://, Drive URL, HTTPS URL, data:) to inlined Data URL for export
  const resolveAssetToDataUrl = async (raw?: string): Promise<string> => {
    const clean = String(raw || '').trim();
    if (!clean) return '';
    if (clean.startsWith('data:')) return clean;
    const driveId = extractDriveFileId(clean);
    if (driveId) {
      return (await fetchDrivePhotoDataUrl(driveId, 2)) || '';
    }
    return (await fetchExternalImageAsDataUrl(clean)) || '';
  };

  const resolveLevelAssetsForExport = async (
    config: LevelConfig
  ): Promise<Omit<ResolvedCardAssetOverrides, 'studentPhoto'>> => {
    const effectiveLogoRaw = config.logoUrl || schoolLogo;
    const effectiveWatermarkRaw = config.watermarkUrl || watermarkUrl;
    const targetWebsite = config.websiteUrl || foundationWebsite || 'https://mambaululum.sch.id';
    const remoteQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(targetWebsite)}&bgcolor=ffffff&color=1e3a8a`;

    const [logo, signature, stamp, watermark, qrResolved] = await Promise.all([
      resolveAssetToDataUrl(effectiveLogoRaw),
      resolveAssetToDataUrl(config.principalSignatureUrl),
      resolveAssetToDataUrl(config.stampUrl),
      resolveAssetToDataUrl(effectiveWatermarkRaw),
      config.qrCodeUrl
        ? resolveAssetToDataUrl(config.qrCodeUrl)
        : fetchExternalImageAsDataUrl(remoteQrUrl).then((d) => d || getFallbackQrSvgDataUrl(targetWebsite)),
    ]);

    return {
      logo,
      signature,
      stamp,
      watermark,
      qr: qrResolved || getFallbackQrSvgDataUrl(targetWebsite),
    };
  };

  const resolveStudentPhotoForExport = async (student: Student): Promise<string> => {
    const fallbackAvatar = getStudentInitialAvatarDataUrl(student.name, student.gender);
    const driveId = extractDriveFileId(student.photoUrl) || student.photoFileId;
    if (driveId) {
      const d = await fetchDrivePhotoDataUrl(driveId, 2);
      if (d) return d;
    }
    if (student.photoUrl && student.photoUrl.trim().length > 10) {
      const ext = await resolveAssetToDataUrl(student.photoUrl);
      if (ext) return ext;
    }
    return fallbackAvatar;
  };

  const captureExportCardSide = async (
    student: Student,
    side: 'front' | 'back'
  ): Promise<string> => {
    await waitNextAnimationFrames(2);
    const elemId = `export-card-${side}-${student.id}`;
    const elem = document.getElementById(elemId);
    if (!elem) {
      throw new Error(`Komponen kartu ${side === 'front' ? 'depan' : 'belakang'} belum siap dirender.`);
    }
    await waitForImagesInsideElement(elem);
    return toJpeg(elem, {
      quality: 0.96,
      pixelRatio: 2.5, // 300 DPI high resolution
      skipFonts: true,
      cacheBust: false,
      backgroundColor: '#ffffff',
    });
  };

  // 1. Download Single Card JPG (Front, Back, or Combined Front+Back)
  const downloadSingleCardJpg = async (student: Student, side: 'front' | 'back' | 'both') => {
    if (isExportingBatch || exportingStudentKey) return;
    setCardError(null);
    setExportingStudentKey(`${student.id}-${side}`);
    try {
      const stdLevel = getStudentLevel(student);
      const cls = classes.find(c => c.id === student.classId);
      const cfg = levelConfigs[stdLevel] || DEFAULT_LEVEL_CONFIGS[stdLevel] || DEFAULT_LEVEL_CONFIGS['SMK'];

      const [sharedAssets, studentPhoto] = await Promise.all([
        resolveLevelAssetsForExport(cfg),
        resolveStudentPhotoForExport(student),
      ]);

      setExportRenderTarget({
        student,
        schoolClass: cls,
        config: cfg,
        hasFace: enrolledStudentIds.has(student.id),
        assets: { ...sharedAssets, studentPhoto },
      });

      const safeName = student.name.replace(/[^a-zA-Z0-9]/g, '_');
      const nisnCode = student.nisn || student.nis;
      let dataUrl = '';
      let filename = '';

      if (side === 'both') {
        const frontDataUrl = await captureExportCardSide(student, 'front');
        const backDataUrl = await captureExportCardSide(student, 'back');
        dataUrl = await composeFrontBackCardJpeg(
          frontDataUrl,
          backDataUrl,
          student,
          cls?.name || 'Reguler',
          stdLevel
        );
        filename = `KARTU_DEPAN_BELAKANG_${nisnCode}_${safeName}.jpg`;
      } else {
        dataUrl = await captureExportCardSide(student, side);
        filename = `KARTU_${side.toUpperCase()}_${nisnCode}_${safeName}.jpg`;
      }

      const link = document.createElement('a');
      link.download = filename;
      link.href = dataUrl;
      link.click();
    } catch (err: any) {
      console.error('Download card error:', err);
      setCardError('Gagal mengunduh kartu: ' + (err?.message || 'Kesalahan tidak diketahui'));
    } finally {
      setExportRenderTarget(null);
      setExportingStudentKey(null);
    }
  };

  // 2. Download Massal Semua Kartu dalam format .ZIP (Sisi Depan, Belakang & Gabungan Depan-Belakang Rapi)
  const downloadBatchZip = async () => {
    if (isExportingBatch || exportingStudentKey) return;
    setCardError(null);
    if (filteredStudents.length === 0) {
      setCardError('Tidak ada siswa yang dipilih.');
      return;
    }

    setIsExportingBatch(true);
    setDownloadSuccessMessage(null);
    const zip = new JSZip();
    const levelSlug = selectedLevel !== 'ALL' ? selectedLevel.replace('/', '_') : 'Semua';
    const rootFolder = zip.folder(`Kartu_Pelajar_${levelSlug}`);
    const frontFolder = rootFolder?.folder('01_Sisi_Depan');
    const backFolder = rootFolder?.folder('02_Sisi_Belakang');
    const combinedFolder = rootFolder?.folder('03_Gabungan_Depan_Belakang');

    try {
      // Pre-resolve shared level assets ONCE per jenjang so Logo, TTD, Stempel, Watermark & QR never disappear
      const levelAssetMap: Partial<Record<EducationLevel, Omit<ResolvedCardAssetOverrides, 'studentPhoto'>>> = {};
      const activeLevelsToExport = Array.from(new Set(filteredStudents.map((s) => getStudentLevel(s))));
      await Promise.all(
        activeLevelsToExport.map(async (lvl) => {
          const cfg = levelConfigs[lvl] || DEFAULT_LEVEL_CONFIGS[lvl] || DEFAULT_LEVEL_CONFIGS['SMK'];
          levelAssetMap[lvl] = await resolveLevelAssetsForExport(cfg);
        })
      );

      // Sort students cleanly by Class Name then Student Name for tidy ZIP file ordering
      const sortedStudents = [...filteredStudents].sort((a, b) => {
        const clsA = classes.find(c => c.id === a.classId)?.name || '';
        const clsB = classes.find(c => c.id === b.classId)?.name || '';
        const clsCmp = clsA.localeCompare(clsB, 'id', { numeric: true });
        if (clsCmp !== 0) return clsCmp;
        return a.name.localeCompare(b.name, 'id');
      });

      const usedFileKeys = new Set<string>();
      let exportedCount = 0;

      for (let i = 0; i < sortedStudents.length; i++) {
        const student = sortedStudents[i];
        setBatchProgress({
          current: i + 1,
          total: sortedStudents.length,
          studentName: student.name,
        });

        const stdLevel = getStudentLevel(student);
        const cls = classes.find(c => c.id === student.classId);
        const cfg = levelConfigs[stdLevel] || DEFAULT_LEVEL_CONFIGS[stdLevel] || DEFAULT_LEVEL_CONFIGS['SMK'];
        const sharedAssets = levelAssetMap[stdLevel] || (await resolveLevelAssetsForExport(cfg));
        const studentPhoto = await resolveStudentPhotoForExport(student);

        setExportRenderTarget({
          student,
          schoolClass: cls,
          config: cfg,
          hasFace: enrolledStudentIds.has(student.id),
          assets: { ...sharedAssets, studentPhoto },
        });

        const frontDataUrl = await captureExportCardSide(student, 'front');
        const backDataUrl = await captureExportCardSide(student, 'back');
        const combinedDataUrl = await composeFrontBackCardJpeg(
          frontDataUrl,
          backDataUrl,
          student,
          cls?.name || 'Reguler',
          stdLevel
        );

        const safeClass = (cls?.name || 'Umum').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        const safeName = student.name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        const nisnCode = String(student.nisn || student.nis || i + 1).replace(/[^a-zA-Z0-9_-]/g, '');
        const indexPrefix = String(i + 1).padStart(3, '0');
        let fileStem = `${indexPrefix}_${safeClass}_${nisnCode}_${safeName}`;
        if (usedFileKeys.has(fileStem)) {
          fileStem = `${fileStem}_${student.id.slice(-4)}`;
        }
        usedFileKeys.add(fileStem);

        frontFolder?.file(`${fileStem}_DEPAN.jpg`, frontDataUrl.replace(/^data:image\/jpeg;base64,/, ''), { base64: true });
        backFolder?.file(`${fileStem}_BELAKANG.jpg`, backDataUrl.replace(/^data:image\/jpeg;base64,/, ''), { base64: true });
        combinedFolder?.file(`${fileStem}_DEPAN_BELAKANG.jpg`, combinedDataUrl.replace(/^data:image\/jpeg;base64,/, ''), { base64: true });
        exportedCount++;

        // Yield briefly to keep UI responsive & allow GC between cards
        await new Promise((r) => setTimeout(r, 8));
      }

      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Kartu_Pelajar_${levelSlug}_${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      const okMsg = `Berhasil mengunduh ${exportedCount} pasang kartu pelajar (Depan, Belakang & Gabungan Depan-Belakang) dalam format ZIP!`;
      setDownloadSuccessMessage(okMsg);
      emitActionToast({ type: 'saved', title: 'Unduhan Selesai', message: okMsg });
    } catch (err: any) {
      console.error('Batch export failed:', err);
      const errMsg = 'Gagal mengekspor massal: ' + (err?.message || 'Kesalahan tidak diketahui');
      setCardError(errMsg);
      emitActionToast({ type: 'error', title: 'Gagal Ekspor', message: errMsg });
    } finally {
      setExportRenderTarget(null);
      setIsExportingBatch(false);
      setBatchProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Offscreen Print/Export Stage — renders BOTH sides synchronously with resolved data URLs regardless of preview filter */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: '-12000px',
          top: 0,
          width: '920px',
          opacity: 1,
          pointerEvents: 'none',
          zIndex: -1,
        }}
      >
        {exportRenderTarget && (
          <div className="flex items-start gap-6 bg-white p-2">
            <StudentCardFront
              cardIdPrefix="export-"
              student={exportRenderTarget.student}
              schoolClass={exportRenderTarget.schoolClass}
              schoolName={schoolName}
              schoolAddress={schoolAddress}
              schoolLogo={schoolLogo}
              watermarkUrl={watermarkUrl}
              hasFaceEnrolled={exportRenderTarget.hasFace}
              config={exportRenderTarget.config}
              resolvedAssetOverrides={exportRenderTarget.assets}
            />
            <StudentCardBack
              cardIdPrefix="export-"
              student={exportRenderTarget.student}
              schoolClass={exportRenderTarget.schoolClass}
              schoolName={schoolName}
              schoolAddress={schoolAddress}
              schoolLogo={schoolLogo}
              foundationWebsite={foundationWebsite}
              watermarkUrl={watermarkUrl}
              config={exportRenderTarget.config}
              resolvedAssetOverrides={exportRenderTarget.assets}
            />
          </div>
        )}
      </div>

      {/* Top Banner & Action Controls */}
      <div className="p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-5">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Multi-Jenjang: SMK • SMP/MTS • SD/MI</span>
            </div>
            <h3 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
              Pusat Cetak & Unduh Kartu Pelajar (Format JPG 300 DPI)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Dilengkapi pas foto berlatar biru resmi, barcode NISN posisi proporsional, tanda tangan kepala sekolah per jenjang, logo & QR website, serta watermark yayasan.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Template Config Editor Modal Trigger */}
            <button
              onClick={() => {
                isDirtyRef.current = false;
                setSaveFeedback(null);
                setShowConfigModal(true);
              }}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 transition"
              title="Sesuaikan Logo, TTD Kepala Sekolah, Website, QR, dan Watermark per Jenjang"
            >
              <Sliders className="w-4 h-4 text-blue-600" />
              <span>Pengaturan Kartu & TTD</span>
            </button>

            {/* Print Directly */}
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 transition"
            >
              <Printer className="w-4 h-4" />
              <span>Cetak Halaman</span>
            </button>

            {/* Mass Download ZIP in JPG */}
            <button
              onClick={downloadBatchZip}
              disabled={isExportingBatch || filteredStudents.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-500/20 disabled:opacity-50 transition"
            >
              {isExportingBatch ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Memproses Unduhan...</span>
                </>
              ) : (
                <>
                  <FileArchive className="w-4 h-4" />
                  <span>Unduh Massal JPG (.ZIP)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Filter Toolbar: Jenjang, Kelas, Pencarian, & Tampilan Sisi */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          {/* 1. Filter Jenjang Pendidikan (Deteksi Otomatis dari Data Siswa) */}
          <div>
            <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
              <School className="w-3.5 h-3.5 text-blue-600" />
              <span>Jenjang Otomatis / Filter:</span>
            </label>
            <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              {(['ALL', 'SMK', 'SMP/MTS', 'SD/MI'] as const).map(lvl => (
                <button
                  key={lvl}
                  onClick={() => {
                    hasManualLevelRef.current = true;
                    setSelectedLevel(lvl);
                    setSelectedClassId('ALL');
                    if (lvl !== 'ALL') setActiveConfigTab(lvl);
                  }}
                  className={`py-1.5 rounded-lg font-bold text-[10px] transition ${
                    selectedLevel === lvl
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
                  }`}
                >
                  {lvl === 'ALL' ? `Semua (${levelCounts.ALL})` : `${lvl.split('/')[0]} (${levelCounts[lvl]})`}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Filter Kelas */}
          <div>
            <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1.5">
              Filter Kelas:
            </label>
            <select
              value={selectedClassId}
              onChange={e => {
                const val = e.target.value;
                setSelectedClassId(val);
                if (val !== 'ALL') {
                  const chosenCls = classes.find(c => c.id === val);
                  if (chosenCls) {
                    const detectedClsLvl = getClassLevel(chosenCls);
                    setActiveConfigTab(detectedClsLvl);
                  }
                }
              }}
              className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-medium"
            >
              <option value="ALL">Semua Kelas ({availableClasses.length} Kelas)</option>
              {availableClasses.map(c => (
                <option key={c.id} value={c.id}>
                  Kelas {c.name} ({getClassLevel(c)})
                </option>
              ))}
            </select>
          </div>

          {/* 3. Search Bar */}
          <div>
            <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1.5">
              Cari Nama / NISN Siswa:
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Ketik nama atau nomor NISN..."
                className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-medium"
              />
            </div>
          </div>

          {/* 4. Sisi Tampilan Kartu (Depan, Belakang, Keduanya) */}
          <div>
            <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-blue-600" />
              <span>Sisi Tampilan Preview:</span>
            </label>
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
              <button
                onClick={() => setCardSideView('both')}
                className={`py-1.5 rounded-lg font-bold text-[11px] transition ${
                  cardSideView === 'both' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                Kedua Sisi
              </button>
              <button
                onClick={() => setCardSideView('front')}
                className={`py-1.5 rounded-lg font-bold text-[11px] transition ${
                  cardSideView === 'front' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                Depan Saja
              </button>
              <button
                onClick={() => setCardSideView('back')}
                className={`py-1.5 rounded-lg font-bold text-[11px] transition ${
                  cardSideView === 'back' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                Belakang Saja
              </button>
            </div>
          </div>
        </div>

        {/* Auto-detected Jenjang Summary */}
        {activeStudents.length > 0 && (
          <div className="p-3 rounded-2xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-900 flex flex-wrap items-center justify-between gap-2 text-[11px] text-indigo-800 dark:text-indigo-200">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-indigo-600 flex-shrink-0" />
              <span>
                <strong>Deteksi Otomatis Jenjang Siswa:</strong>{' '}
                {activeLevelsPresent.length === 1
                  ? `Seluruh ${activeStudents.length} siswa aktif berada di jenjang ${activeLevelsPresent[0]} (dipilih otomatis).`
                  : `Terdeteksi ${activeLevelsPresent.map(l => `${l}: ${levelCounts[l]}`).join(' • ')} — setiap kartu otomatis memakai template jenjang masing-masing siswa.`}
              </span>
            </div>
            {hasManualLevelRef.current && (
              <button
                type="button"
                onClick={() => {
                  hasManualLevelRef.current = false;
                  setSelectedClassId('ALL');
                  if (activeLevelsPresent.length === 1) {
                    setSelectedLevel(activeLevelsPresent[0]);
                    setActiveConfigTab(activeLevelsPresent[0]);
                  } else {
                    setSelectedLevel('ALL');
                    setActiveConfigTab(dominantLevel);
                  }
                }}
                className="font-bold text-indigo-700 dark:text-indigo-300 hover:underline flex-shrink-0"
              >
                Deteksi Ulang Otomatis
              </button>
            )}
          </div>
        )}

        {/* Error Alert Banner */}
        {cardError && (
          <div className="p-3.5 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200 flex items-center justify-between gap-2">
            <span>{cardError}</span>
            <button
              type="button"
              onClick={() => setCardError(null)}
              className="font-bold text-red-600 dark:text-red-300 hover:underline"
            >
              Tutup
            </button>
          </div>
        )}

        {/* Success Alert Banner */}
        {downloadSuccessMessage && (
          <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span>{downloadSuccessMessage}</span>
          </div>
        )}

        {/* Batch Progress Bar Modal/Overlay */}
        {isExportingBatch && batchProgress && (
          <div className="p-4 rounded-2xl bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-blue-900 dark:text-blue-100">
              <span className="flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600" />
                <span>Membuat Gambar JPG: <strong>{batchProgress.studentName}</strong></span>
              </span>
              <span>
                {batchProgress.current} dari {batchProgress.total} Siswa ({Math.round((batchProgress.current / batchProgress.total) * 100)}%)
              </span>
            </div>
            <div className="w-full bg-blue-200 dark:bg-blue-900 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-150"
                style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Main Student Card Grid */}
      {filteredStudents.length === 0 ? (
        <div className="p-12 text-center rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2">
          <AlertCircle className="w-8 h-8 text-slate-400 mx-auto" />
          <h4 className="text-sm font-bold text-slate-800 dark:text-white">Tidak Ada Data Siswa Ditemukan</h4>
          <p className="text-xs text-slate-500">Coba ubah filter jenjang, kelas, atau kata kunci pencarian Anda.</p>
        </div>
      ) : (
        <div className="space-y-8">
          <div className="flex items-center justify-between text-xs text-slate-500 px-1">
            <span>
              Menampilkan <strong>{filteredStudents.length} Siswa</strong> siap unduh & cetak
            </span>
            <span className="text-slate-400">
              Format Ekspor: <strong>JPG Kualitas Tinggi (300 DPI)</strong>
            </span>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 print:grid-cols-1">
            {filteredStudents.map(student => {
              const cls = classes.find(c => c.id === student.classId);
              const stdLevel = getStudentLevel(student);
              const config = levelConfigs[stdLevel] || DEFAULT_LEVEL_CONFIGS['SMK'];
              const hasFace = enrolledStudentIds.has(student.id);

              return (
                <div
                  key={student.id}
                  className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4 print:break-inside-avoid print:shadow-none print:border-none"
                >
                  {/* Card Title & Download Action Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-xl bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 flex items-center justify-center font-bold text-xs">
                        {stdLevel.split('/')[0]}
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-black text-sm text-slate-900 dark:text-white line-clamp-1">
                            {student.name}
                          </span>
                          <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                            Jenjang: {stdLevel}
                          </span>
                          {hasFace && (
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                              ✓ Wajah Terdaftar
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500">
                          NISN: {student.nisn || student.nis} • Kelas: {cls?.name || '-'}
                          {student.address ? ` • ${student.address}` : ''}
                        </div>
                      </div>
                    </div>

                    {/* Single Student JPG Download Buttons */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={() => downloadSingleCardJpg(student, 'front')}
                        disabled={isExportingBatch || Boolean(exportingStudentKey)}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 disabled:opacity-50 transition flex items-center gap-1"
                        title="Unduh Bagian Depan Kartu (JPG)"
                      >
                        {exportingStudentKey === `${student.id}-front` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        <span>JPG Depan</span>
                      </button>

                      <button
                        onClick={() => downloadSingleCardJpg(student, 'back')}
                        disabled={isExportingBatch || Boolean(exportingStudentKey)}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 disabled:opacity-50 transition flex items-center gap-1"
                        title="Unduh Bagian Belakang Kartu (JPG)"
                      >
                        {exportingStudentKey === `${student.id}-back` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        <span>JPG Belakang</span>
                      </button>

                      <button
                        onClick={() => downloadSingleCardJpg(student, 'both')}
                        disabled={isExportingBatch || Boolean(exportingStudentKey)}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 disabled:opacity-50 transition flex items-center gap-1"
                        title="Unduh Gabungan Depan & Belakang Siap Cetak (JPG)"
                      >
                        {exportingStudentKey === `${student.id}-both` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        <span>Depan+Belakang</span>
                      </button>
                    </div>
                  </div>

                  {/* Render Front & Back Cards */}
                  <div className="flex flex-wrap items-center justify-center gap-5 overflow-x-auto py-2">
                    {(cardSideView === 'both' || cardSideView === 'front') && (
                      <div className="flex-shrink-0">
                        <StudentCardFront
                          student={student}
                          schoolClass={cls}
                          schoolName={schoolName}
                          schoolAddress={schoolAddress}
                          schoolLogo={schoolLogo}
                          watermarkUrl={watermarkUrl}
                          hasFaceEnrolled={hasFace}
                          config={config}
                        />
                      </div>
                    )}

                    {(cardSideView === 'both' || cardSideView === 'back') && (
                      <div className="flex-shrink-0">
                        <StudentCardBack
                          student={student}
                          schoolClass={cls}
                          schoolName={schoolName}
                          schoolAddress={schoolAddress}
                          schoolLogo={schoolLogo}
                          foundationWebsite={foundationWebsite}
                          watermarkUrl={watermarkUrl}
                          config={config}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* MODAL: PENGATURAN TEMPLATE JENJANG (SMK, SMP/MTS, SD/MI) */}
      {showConfigModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 sm:p-8 shadow-2xl space-y-6">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <Sliders className="w-5 h-5 text-blue-600" />
                <div>
                  <h4 className="text-base font-black text-slate-900 dark:text-white">
                    Kustomisasi Kartu Pelajar & Data Jenjang
                  </h4>
                  <p className="text-xs text-slate-500">
                    Upload tanda tangan kepala sekolah, logo jenjang, website, QR code, dan watermark
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  isDirtyRef.current = false;
                  setSaveFeedback(null);
                  setShowConfigModal(false);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-xl"
              >
                ✕
              </button>
            </div>

            {/* Jenjang Switcher Tabs */}
            <div className="flex gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
              {(['SMK', 'SMP/MTS', 'SD/MI'] as EducationLevel[]).map(lvl => (
                <button
                  key={lvl}
                  onClick={() => setActiveConfigTab(lvl)}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
                    activeConfigTab === lvl
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>

            {/* Active Jenjang Config Form */}
            {levelConfigs[activeConfigTab] && (
              <div className="space-y-5 text-xs">
                {/* 1. Nama Unit & Alamat Khusus */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                      Nama Unit / Sekolah ({activeConfigTab}):
                    </label>
                    <input
                      type="text"
                      value={levelConfigs[activeConfigTab].unitName}
                      onChange={e =>
                        updateLevelConfigs({
                          ...levelConfigs,
                          [activeConfigTab]: { ...levelConfigs[activeConfigTab], unitName: e.target.value },
                        })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold text-slate-900 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-blue-600" />
                      <span>Alamat Sekolah ({activeConfigTab}):</span>
                    </label>
                    <input
                      type="text"
                      value={levelConfigs[activeConfigTab].schoolAddress || ''}
                      placeholder={schoolAddress || 'Jl. Pesantren Mambaul Ulum, Diwek, Jombang'}
                      onChange={e =>
                        updateLevelConfigs({
                          ...levelConfigs,
                          [activeConfigTab]: { ...levelConfigs[activeConfigTab], schoolAddress: e.target.value },
                        })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                    />
                  </div>
                </div>

                {/* 2. Kepala Sekolah & Tanda Tangan */}
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-3">
                  <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <PenTool className="w-4 h-4 text-blue-600" />
                    <span>Kepala Sekolah & Tanda Tangan Resmi ({activeConfigTab})</span>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Alamat / Kota &amp; Tanggal di Atas TTD Kepala Sekolah ({activeConfigTab}):
                    </label>
                    <input
                      type="text"
                      value={levelConfigs[activeConfigTab].signaturePlaceDate ?? ''}
                      placeholder="Contoh: Jombang, 15 Juli 2026"
                      onChange={e =>
                        updateLevelConfigs({
                          ...levelConfigs,
                          [activeConfigTab]: {
                            ...levelConfigs[activeConfigTab],
                            signaturePlaceDate: e.target.value,
                          },
                        })
                      }
                      className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                    />
                    <span className="text-[10px] text-slate-500 mt-1 block">
                      Tampil tepat di atas tulisan &ldquo;Kepala {levelConfigs[activeConfigTab].unitName}&rdquo; &amp; tanda tangan di pojok kanan bawah kartu depan.
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-600 dark:text-slate-300 mb-1">
                        Nama Kepala Sekolah:
                      </label>
                      <input
                        type="text"
                        value={levelConfigs[activeConfigTab].principalName}
                        onChange={e =>
                          updateLevelConfigs({
                            ...levelConfigs,
                            [activeConfigTab]: { ...levelConfigs[activeConfigTab], principalName: e.target.value },
                          })
                        }
                        className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-600 dark:text-slate-300 mb-1">
                        NIP / NIY Kepala Sekolah:
                      </label>
                      <input
                        type="text"
                        value={levelConfigs[activeConfigTab].principalNip}
                        onChange={e =>
                          updateLevelConfigs({
                            ...levelConfigs,
                            [activeConfigTab]: { ...levelConfigs[activeConfigTab], principalNip: e.target.value },
                          })
                        }
                        className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                      />
                    </div>
                  </div>

                  {/* Upload Signature Box */}
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <span className="font-bold text-slate-700 dark:text-slate-300 block">
                          Upload Gambar Tanda Tangan Kepala Sekolah (PNG Transparan / JPG):
                        </span>
                        <span className="text-[11px] text-slate-500">
                          Ukuran proporsional otomatis mengikuti gambar asli (stempel hijau otomatis hilang saat TTD diganti).
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {levelConfigs[activeConfigTab].principalSignatureUrl ? (
                          <div className="flex items-center gap-2">
                            <DriveImage
                              src={levelConfigs[activeConfigTab].principalSignatureUrl}
                              alt="TTD"
                              className="h-12 max-w-[140px] bg-white p-1 rounded-lg border border-slate-300 object-contain"
                            />
                            <button
                              type="button"
                              disabled={deletingField === 'principalSignatureUrl'}
                              onClick={() => handleDeleteAssetField('principalSignatureUrl', 'Tanda Tangan Kepala Sekolah')}
                              className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                              title="Hapus Tanda Tangan dari Drive & Sheet"
                            >
                              {deletingField === 'principalSignatureUrl' ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Trash2 className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <label className="cursor-pointer px-3.5 py-2 rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 font-bold flex items-center gap-1.5 transition">
                            {uploadingField === 'principalSignatureUrl' ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Mengunggah ke Drive...</span>
                              </>
                            ) : (
                              <>
                                <Upload className="w-3.5 h-3.5" />
                                <span>Pilih File TTD</span>
                              </>
                            )}
                            <input
                              type="file"
                              accept="image/*"
                              disabled={Boolean(uploadingField) || Boolean(deletingField)}
                              className="hidden"
                              onChange={e => handleFileUpload(e, 'principalSignatureUrl')}
                            />
                          </label>
                        )}
                      </div>
                    </div>

                    {/* Signature Scale & Stamp Control */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200/70 dark:border-slate-700/70">
                      <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-slate-200">
                          <span>Ukuran Tanda Tangan di Kartu</span>
                          <span className="font-mono text-blue-600">
                            {levelConfigs[activeConfigTab].signatureScale ?? 100}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={60}
                          max={160}
                          step={5}
                          value={levelConfigs[activeConfigTab].signatureScale ?? 100}
                          onChange={e =>
                            updateLevelConfigs({
                              ...levelConfigs,
                              [activeConfigTab]: {
                                ...levelConfigs[activeConfigTab],
                                signatureScale: Number(e.target.value),
                              },
                            })
                          }
                          className="w-full accent-blue-600 cursor-pointer"
                        />
                        <div className="flex justify-between text-[10px] text-slate-400">
                          <span>Kecil (60%)</span>
                          <button
                            type="button"
                            onClick={() =>
                              updateLevelConfigs({
                                ...levelConfigs,
                                [activeConfigTab]: {
                                  ...levelConfigs[activeConfigTab],
                                  signatureScale: 100,
                                },
                              })
                            }
                            className="text-blue-600 hover:underline font-semibold"
                          >
                            Reset 100%
                          </button>
                          <span>Besar (160%)</span>
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                            Stempel Kartu ({activeConfigTab})
                          </span>
                          <div className="flex items-center gap-1.5">
                            {levelConfigs[activeConfigTab].stampUrl ? (
                              <>
                                <DriveImage
                                  src={levelConfigs[activeConfigTab].stampUrl}
                                  alt="Stempel"
                                  className="w-8 h-8 rounded bg-slate-50 p-0.5 border border-slate-300 object-contain"
                                />
                                <button
                                  type="button"
                                  disabled={deletingField === 'stampUrl'}
                                  onClick={() => handleDeleteAssetField('stampUrl', 'Stempel Sekolah')}
                                  className="p-1 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                                  title="Hapus Stempel dari Drive & Sheet"
                                >
                                  {deletingField === 'stampUrl' ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </>
                            ) : (
                              <label className="cursor-pointer px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 text-[11px] font-bold flex items-center gap-1 transition">
                                {uploadingField === 'stampUrl' ? (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>Upload...</span>
                                  </>
                                ) : (
                                  <>
                                    <Upload className="w-3 h-3" />
                                    <span>Ganti Stempel</span>
                                  </>
                                )}
                                <input
                                  type="file"
                                  accept="image/*"
                                  disabled={Boolean(uploadingField) || Boolean(deletingField)}
                                  className="hidden"
                                  onChange={e => handleFileUpload(e, 'stampUrl')}
                                />
                              </label>
                            )}
                          </div>
                        </div>

                        <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={
                              levelConfigs[activeConfigTab].hideStamp ??
                              Boolean(levelConfigs[activeConfigTab].principalSignatureUrl)
                            }
                            onChange={e =>
                              updateLevelConfigs({
                                ...levelConfigs,
                                [activeConfigTab]: {
                                  ...levelConfigs[activeConfigTab],
                                  hideStamp: e.target.checked,
                                },
                              })
                            }
                            className="rounded text-blue-600 focus:ring-blue-500"
                          />
                          <span>Hapus / sembunyikan stempel hijau bawaan</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. Logo Sekolah & Watermark Kartu */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Upload Logo Per Jenjang */}
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2">
                    <span className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <ImageIcon className="w-4 h-4 text-emerald-600" />
                      <span>Logo Sekolah Jenjang ({activeConfigTab})</span>
                    </span>
                    <p className="text-[11px] text-slate-500">
                      Tersimpan otomatis ke folder Google Drive sekolah.
                    </p>

                    <div className="flex items-center gap-2 pt-1">
                      {levelConfigs[activeConfigTab].logoUrl ? (
                        <div className="flex items-center gap-2">
                          <DriveImage
                            src={levelConfigs[activeConfigTab].logoUrl}
                            alt="Logo"
                            className="w-10 h-10 rounded-full bg-white p-1 border border-slate-300 object-contain"
                          />
                          <button
                            type="button"
                            disabled={deletingField === 'logoUrl'}
                            onClick={() => handleDeleteAssetField('logoUrl', 'Logo Sekolah')}
                            className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                            title="Hapus Logo dari Drive & Sheet"
                          >
                            {deletingField === 'logoUrl' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <label className="cursor-pointer px-3 py-1.5 rounded-xl bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 font-bold flex items-center gap-1.5 transition">
                          {uploadingField === 'logoUrl' ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Mengunggah ke Drive...</span>
                            </>
                          ) : (
                            <>
                              <Upload className="w-3.5 h-3.5" />
                              <span>Upload Logo</span>
                            </>
                          )}
                          <input
                            type="file"
                            accept="image/*"
                            disabled={Boolean(uploadingField) || Boolean(deletingField)}
                            className="hidden"
                            onChange={e => handleFileUpload(e, 'logoUrl')}
                          />
                        </label>
                      )}
                    </div>
                  </div>

                  {/* Upload Watermark Background */}
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2">
                    <span className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <Layers className="w-4 h-4 text-amber-600" />
                      <span>Watermark Background Kartu</span>
                    </span>
                    <p className="text-[11px] text-slate-500">
                      Gambar transparan tersimpan di Drive &amp; tampil di background kartu.
                    </p>

                    <div className="flex items-center gap-2 pt-1">
                      {levelConfigs[activeConfigTab].watermarkUrl ? (
                        <div className="flex items-center gap-2">
                          <DriveImage
                            src={levelConfigs[activeConfigTab].watermarkUrl}
                            alt="Watermark"
                            className="w-10 h-10 rounded-lg bg-white p-1 border border-slate-300 object-contain"
                          />
                          <button
                            type="button"
                            disabled={deletingField === 'watermarkUrl'}
                            onClick={() => handleDeleteAssetField('watermarkUrl', 'Watermark Kartu')}
                            className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                            title="Hapus Watermark dari Drive & Sheet"
                          >
                            {deletingField === 'watermarkUrl' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <label className="cursor-pointer px-3 py-1.5 rounded-xl bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-300 font-bold flex items-center gap-1.5 transition">
                          {uploadingField === 'watermarkUrl' ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Mengunggah ke Drive...</span>
                            </>
                          ) : (
                            <>
                              <Upload className="w-3.5 h-3.5" />
                              <span>Upload Watermark</span>
                            </>
                          )}
                          <input
                            type="file"
                            accept="image/*"
                            disabled={Boolean(uploadingField) || Boolean(deletingField)}
                            className="hidden"
                            onChange={e => handleFileUpload(e, 'watermarkUrl')}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                </div>

                {/* 4. Website Sekolah & QR Code Belakang Kartu */}
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-3">
                  <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <Globe className="w-4 h-4 text-blue-600" />
                    <span>Website & Kode QR Belakang Kartu ({activeConfigTab})</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-600 dark:text-slate-300 mb-1">
                        URL Website Sekolah:
                      </label>
                      <input
                        type="text"
                        value={levelConfigs[activeConfigTab].websiteUrl || ''}
                        placeholder={foundationWebsite || 'https://mambaululum.sch.id'}
                        onChange={e =>
                          updateLevelConfigs({
                            ...levelConfigs,
                            [activeConfigTab]: { ...levelConfigs[activeConfigTab], websiteUrl: e.target.value },
                          })
                        }
                        className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                      />
                      <span className="text-[10px] text-slate-400 mt-0.5 block">
                        Kode QR di belakang kartu otomatis terbuat mengarah ke URL ini.
                      </span>
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-600 dark:text-slate-300 mb-1">
                        Upload Gambar QR Khusus (Opsional):
                      </label>
                      <div className="flex items-center gap-2">
                        {levelConfigs[activeConfigTab].qrCodeUrl ? (
                          <div className="flex items-center gap-2">
                            <DriveImage
                              src={levelConfigs[activeConfigTab].qrCodeUrl}
                              alt="Custom QR"
                              className="w-9 h-9 rounded-md bg-white p-0.5 border border-slate-300 object-contain"
                            />
                            <button
                              type="button"
                              disabled={deletingField === 'qrCodeUrl'}
                              onClick={() => handleDeleteAssetField('qrCodeUrl', 'Gambar QR Khusus')}
                              className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded disabled:opacity-50"
                              title="Hapus QR dari Drive & Sheet"
                            >
                              {deletingField === 'qrCodeUrl' ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <label className="cursor-pointer px-3 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-semibold flex items-center gap-1.5 transition">
                            {uploadingField === 'qrCodeUrl' ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Mengunggah...</span>
                              </>
                            ) : (
                              <>
                                <Upload className="w-3.5 h-3.5" />
                                <span>Pilih File QR</span>
                              </>
                            )}
                            <input
                              type="file"
                              accept="image/*"
                              disabled={Boolean(uploadingField) || Boolean(deletingField)}
                              className="hidden"
                              onChange={e => handleFileUpload(e, 'qrCodeUrl')}
                            />
                          </label>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 5. Visi & Misi */}
                <div>
                  <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Visi Sekolah ({activeConfigTab}):
                  </label>
                  <textarea
                    rows={2}
                    value={levelConfigs[activeConfigTab].vision}
                    onChange={e =>
                      updateLevelConfigs({
                        ...levelConfigs,
                        [activeConfigTab]: { ...levelConfigs[activeConfigTab], vision: e.target.value },
                      })
                    }
                    className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Misi Sekolah (Satu per baris):
                  </label>
                  <textarea
                    rows={3}
                    value={levelConfigs[activeConfigTab].missions.join('\n')}
                    onChange={e =>
                      updateLevelConfigs({
                        ...levelConfigs,
                        [activeConfigTab]: {
                          ...levelConfigs[activeConfigTab],
                          missions: e.target.value.split('\n').filter(Boolean),
                        },
                      })
                    }
                    className="w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-mono text-[11px]"
                  />
                </div>
              </div>
            )}

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                {saveFeedback && (
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-bold ${
                      saveFeedback.type === 'success'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {saveFeedback.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    )}
                    <span>{saveFeedback.text}</span>
                  </span>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={isSavingConfig}
                  onClick={() => updateLevelConfigs(DEFAULT_LEVEL_CONFIGS)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  Reset Default
                </button>
                <button
                  type="button"
                  disabled={isSavingConfig}
                  onClick={handleSaveConfigs}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm disabled:opacity-60 transition cursor-pointer"
                >
                  {isSavingConfig ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Simpan &amp; Terapkan Perubahan</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
