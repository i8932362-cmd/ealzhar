import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  Settings,
  Users,
  Camera,
  MapPin,
  GraduationCap,
  Upload,
  Download,
  Shield,
  Plus,
  Trash2,
  Check,
  AlertCircle,
  QrCode,
  Search,
  CheckCircle2,
  Briefcase,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Table,
  Pencil,
  Layers,
  Loader2,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useSync } from '../../context/SyncContext.tsx';
import {
  SchoolSettings,
  SchoolClass,
  Student,
  Teacher,
  SchoolLocation,
  FaceTemplate,
  TeacherAttendance,
  AttendanceSession,
  SessionTargetType,
  EducationLevel,
} from '../../types/index.ts';
import {
  gasGet,
  gasPost,
  getWibTodayStr,
  uploadImageAssetToDrive,
  deleteImageAssetFromDrive,
  extractDriveFileId,
} from '../../lib/api.ts';
import { emitActionToast } from '../../lib/toast.ts';
import { DriveImage } from '../common/DriveImage.tsx';
import {
  formatWibTime24,
  formatWibDateTime24,
  generateSessionSheetName,
  sortSessions,
} from '../../lib/sessions.ts';
import {
  loadFaceDetectionModels,
  areFaceModelsLoaded,
  acquireCameraStream,
  attachStreamToVideo,
  stopMediaStreamSafely,
  attachCameraResumeListeners,
  detectSingleFaceDescriptor,
  detectFaceDescriptorFromImage,
  parseCameraError,
} from '../../lib/faceDetection.ts';
import { TableSkeleton } from '../common/Skeleton.tsx';
import { ConfirmModal } from '../common/ConfirmModal.tsx';
import { TimeInput24h } from '../common/TimeInput24h.tsx';
import { CameraPreviewStage } from '../common/CameraPreviewStage.tsx';

function normalizeEducationLevel(raw?: string): EducationLevel | '' {
  const up = String(raw || '').toUpperCase().replace(/\s+/g, '');
  if (!up) return '';
  if (up === 'SD/MI' || up === 'SD' || up === 'MI' || up.startsWith('SD') || up.startsWith('MI')) return 'SD/MI';
  if (up === 'SMP/MTS' || up === 'SMP' || up === 'MTS' || up.startsWith('SMP') || up.startsWith('MTS')) return 'SMP/MTS';
  if (up === 'SMK' || up === 'SMA/MA' || up === 'SMA' || up === 'MA' || up.startsWith('SMK') || up.startsWith('SMA') || up.startsWith('MA')) return 'SMK';
  return '';
}

function detectExplicitLevelFromClassName(className?: string): EducationLevel | '' {
  const clsUp = String(className || '').toUpperCase().trim();
  if (!clsUp) return '';
  if (/\b(SMK|SMA|MA)\b/.test(clsUp)) return 'SMK';
  if (/\b(SMP|MTS)\b/.test(clsUp)) return 'SMP/MTS';
  if (/\b(SD|MI)\b/.test(clsUp)) return 'SD/MI';
  if (/\b(XII|XI|X)\b/.test(clsUp) || /(?:^|[\s\-_/])(12|11|10)(?![0-9])/.test(clsUp)) return 'SMK';
  if (/\b(IX|VIII|VII)\b/.test(clsUp) || /(?:^|[\s\-_/])(9|8|7)(?![0-9])/.test(clsUp)) return 'SMP/MTS';
  if (/\b(VI|V|IV|III|II|I)\b/.test(clsUp) || /(?:^|[\s\-_/])(6|5|4|3|2|1)(?![0-9])/.test(clsUp)) return 'SD/MI';
  return '';
}

function inferEducationLevel(rawLevel?: string, grade?: string | number, className?: string): EducationLevel {
  const direct = normalizeEducationLevel(rawLevel);
  if (direct) return direct;
  const g = Number(String(grade || '').replace(/[^0-9]/g, ''));
  if (!Number.isNaN(g) && g >= 1 && g <= 12) {
    if (g <= 6) return 'SD/MI';
    if (g <= 9) return 'SMP/MTS';
    return 'SMK';
  }
  const byName = detectExplicitLevelFromClassName(className);
  if (byName) return byName;
  return 'SMK';
}
import { PasswordInput } from '../common/PasswordInput.tsx';
import { StudentCardManager } from './StudentCardManager.tsx';

export const AdminDashboard: React.FC = () => {
  const { user } = useAuth();
  const {
    settings,
    updateSettings,
    notifyFaceDatabaseChanged,
    serverVersion,
    activeUsers,
    classes,
    students,
    teachers,
    locations,
    users: usersList,
    auditLogs,
    faceTemplates,
    sessions,
    activeStudentSession,
    activeTeacherSession,
    wibNowHhMm,
    saveStatus,
    saveMessage,
  } = useSync();

  // Tabs
  const [activeTab, setActiveTab] = useState<
    'settings' | 'users' | 'face_db' | 'locations' | 'classes' | 'students' | 'bulk_upload' | 'id_cards' | 'teacher_recap' | 'audit_log'
  >('settings');
  const [pendingFaceTarget, setPendingFaceTarget] = useState<{
    personType: 'student' | 'teacher';
    personId: string;
  } | null>(null);

  // Settings form
  const [settingsForm, setSettingsForm] = useState<Partial<SchoolSettings>>({});
  const [settingsSaved, setSettingsSaved] = useState<boolean>(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false);
  const [uploadingSettingAsset, setUploadingSettingAsset] = useState<'schoolLogo' | 'foundationWatermarkUrl' | null>(null);
  const [deletingSettingAsset, setDeletingSettingAsset] = useState<'schoolLogo' | 'foundationWatermarkUrl' | null>(null);
  const isDirtySettingsRef = useRef<boolean>(false);

  // Brief header badge state + global z-[200] front-most notifications
  const [savedBadge, setSavedBadge] = useState<boolean>(false);
  const savedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerSavedToast = useCallback((msg: string) => {
    setSavedBadge(true);
    if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current);
    savedToastTimerRef.current = setTimeout(() => {
      setSavedBadge(false);
    }, 3500);
    emitActionToast({ type: 'saved', title: 'Tersimpan', message: msg });
  }, []);

  const triggerDeletedToast = useCallback((msg: string) => {
    emitActionToast({ type: 'deleted', title: 'Terhapus', message: msg });
  }, []);

  const triggerErrorToast = useCallback((msg: string) => {
    emitActionToast({ type: 'error', title: 'Gagal', message: msg });
  }, []);

  useEffect(() => {
    return () => {
      if (savedToastTimerRef.current) clearTimeout(savedToastTimerRef.current);
    };
  }, []);

  const handleDataMutated = useCallback(async () => {
    await notifyFaceDatabaseChanged();
  }, [notifyFaceDatabaseChanged]);

  useEffect(() => {
    if (settings && !isDirtySettingsRef.current) {
      setSettingsForm(settings);
    }
  }, [settings]);

  const updateSettingsField = <K extends keyof SchoolSettings>(key: K, value: SchoolSettings[K]) => {
    isDirtySettingsRef.current = true;
    setSettingsSaved(false);
    setSettingsForm((prev) => ({ ...prev, [key]: value }));
  };

  // Upload Logo Sekolah / Watermark Global directly into Google Drive folder 04_Logo_TTD_dan_Aset_Kartu & save to Sheets
  const handleUploadSettingAsset = async (
    field: 'schoolLogo' | 'foundationWatermarkUrl',
    file: File
  ) => {
    if (uploadingSettingAsset || deletingSettingAsset) return;
    setUploadingSettingAsset(field);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const up = await uploadImageAssetToDrive(file, {
        purpose: field === 'schoolLogo' ? 'school_logo' : 'foundation_watermark',
        previousUrl: String(settingsForm[field] || ''),
        trashPrevious: true,
      });
      const nextForm: Partial<SchoolSettings> = {
        ...settingsForm,
        [field]: up.photoUrl,
      };
      const ok = await updateSettings(nextForm);
      if (ok) {
        isDirtySettingsRef.current = false;
        setSettingsForm(nextForm);
        setSettingsSaved(true);
        const label = field === 'schoolLogo' ? 'Logo sekolah' : 'Watermark global kartu';
        triggerSavedToast(`${label} berhasil diupload ke Google Drive & tersimpan di Sheets.`);
        setTimeout(() => setSettingsSaved(false), 3500);
      } else {
        const errMsg = 'Gambar terunggah ke Drive, namun gagal menyimpan tautan ke Google Sheets.';
        setSettingsError(errMsg);
        triggerErrorToast(errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal mengunggah gambar ke Google Drive.';
      setSettingsError(errMsg);
      triggerErrorToast(errMsg);
    } finally {
      setUploadingSettingAsset(null);
    }
  };

  // Delete Logo Sekolah / Watermark Global from BOTH Google Drive & Google Sheets
  const handleDeleteSettingAsset = async (field: 'schoolLogo' | 'foundationWatermarkUrl') => {
    if (uploadingSettingAsset || deletingSettingAsset) return;
    setDeletingSettingAsset(field);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const curVal = String(settingsForm[field] || '');
      const fileId = extractDriveFileId(curVal);
      if (fileId) {
        const deleted = await deleteImageAssetFromDrive(fileId);
        if (!deleted) {
          throw new Error('Gagal menghapus file gambar dari Google Drive.');
        }
      }
      const nextForm: Partial<SchoolSettings> = {
        ...settingsForm,
        [field]: '',
      };
      const ok = await updateSettings(nextForm);
      if (ok) {
        isDirtySettingsRef.current = false;
        setSettingsForm(nextForm);
        const label = field === 'schoolLogo' ? 'Logo sekolah' : 'Watermark global kartu';
        triggerDeletedToast(`${label} berhasil dihapus bersih dari Google Drive & Sheets.`);
      } else {
        const errMsg = 'Gagal menghapus referensi gambar dari Google Sheets.';
        setSettingsError(errMsg);
        triggerErrorToast(errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal menghapus gambar dari Google Drive.';
      setSettingsError(errMsg);
      triggerErrorToast(errMsg);
    } finally {
      setDeletingSettingAsset(null);
    }
  };

  // Save Settings (with changed_at conflict protection)
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingSettings) return;
    setIsSavingSettings(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const ok = await updateSettings(settingsForm);
      if (ok) {
        isDirtySettingsRef.current = false;
        setSettingsSaved(true);
        triggerSavedToast('Pengaturan sekolah tersimpan ke Google Sheets!');
        setTimeout(() => setSettingsSaved(false), 3500);
      } else {
        const errMsg = 'Gagal memperbarui pengaturan sekolah.';
        setSettingsError(errMsg);
        triggerErrorToast(errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal menyimpan pengaturan ke Google Sheets.';
      setSettingsError(errMsg);
      triggerErrorToast(errMsg);
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Download Student & Teacher Template (.xlsx) tailored to chosen Jenjang
  const handleDownloadTemplate = (preferredLevel?: EducationLevel) => {
    const fallbackClassFor = (lvl: EducationLevel, idx: number) => {
      const match = classes.find(c => inferEducationLevel(c.level, c.grade, c.name) === lvl);
      if (match) return match.name;
      if (lvl === 'SD/MI') return idx === 0 ? 'IV SD A' : 'V SD B';
      if (lvl === 'SMP/MTS') return idx === 0 ? 'VII SMP A' : 'VIII SMP B';
      return idx === 0 ? 'X SMK A' : 'XI SMK B';
    };

    const studentSample = preferredLevel
      ? [
          {
            nis: '10202610',
            nisn: '0071234580',
            nama: 'Ahmad Zaki Fauzan',
            jenisKelamin: 'L',
            tempatLahir: 'Jombang',
            tanggalLahir: '12-08-2009',
            jenjang: preferredLevel,
            kelas: fallbackClassFor(preferredLevel, 0),
            alamat: 'Jl. Pesantren No. 12, Diwek, Jombang',
            barcodeCard: 'CARD-10202610',
            noHpOrtu: '081234567890',
          },
          {
            nis: '10202611',
            nisn: '0071234581',
            nama: 'Nabila Putri Cahyani',
            jenisKelamin: 'P',
            tempatLahir: 'Mojokerto',
            tanggalLahir: '04-03-2010',
            jenjang: preferredLevel,
            kelas: fallbackClassFor(preferredLevel, 1),
            alamat: 'Dusun Krajan RT 02/RW 01, Peterongan, Jombang',
            barcodeCard: 'CARD-10202611',
            noHpOrtu: '081234567891',
          },
        ]
      : [
          {
            nis: '10202610',
            nisn: '0071234580',
            nama: 'Ahmad Zaki Fauzan',
            jenisKelamin: 'L',
            tempatLahir: 'Jombang',
            tanggalLahir: '12-08-2009',
            jenjang: 'SMK',
            kelas: fallbackClassFor('SMK', 0),
            alamat: 'Jl. Pesantren No. 12, Diwek, Jombang',
            barcodeCard: 'CARD-10202610',
            noHpOrtu: '081234567890',
          },
          {
            nis: '10202611',
            nisn: '0071234581',
            nama: 'Nabila Putri Cahyani',
            jenisKelamin: 'P',
            tempatLahir: 'Mojokerto',
            tanggalLahir: '04-03-2010',
            jenjang: 'SMP/MTS',
            kelas: fallbackClassFor('SMP/MTS', 0),
            alamat: 'Dusun Krajan RT 02/RW 01, Peterongan, Jombang',
            barcodeCard: 'CARD-10202611',
            noHpOrtu: '081234567891',
          },
          {
            nis: '10202612',
            nisn: '0071234582',
            nama: 'Muhammad Farhan',
            jenisKelamin: 'L',
            tempatLahir: 'Jombang',
            tanggalLahir: '19-11-2015',
            jenjang: 'SD/MI',
            kelas: fallbackClassFor('SD/MI', 0),
            alamat: 'Jl. Merdeka No. 8, Mojoagung, Jombang',
            barcodeCard: 'CARD-10202612',
            noHpOrtu: '081234567892',
          },
        ];

    const teacherSample = [
      {
        nip: '198705122011011004',
        name: 'Hendra Gunawan, M.Kom',
        email: 'hendra.gunawan@sekolah.sch.id',
        phone: '081234567892',
        subject: 'Pemrograman Web',
      },
    ];

    const wb = XLSX.utils.book_new();
    const wsStudents = XLSX.utils.json_to_sheet(studentSample);
    const wsTeachers = XLSX.utils.json_to_sheet(teacherSample);

    XLSX.utils.book_append_sheet(wb, wsStudents, 'Template_Siswa');
    XLSX.utils.book_append_sheet(wb, wsTeachers, 'Template_Guru');
    const levelSlug = preferredLevel ? `_${preferredLevel.replace('/', '_')}` : '';
    XLSX.writeFile(wb, `Template_Import_Siswa${levelSlug}.xlsx`);
  };

  return (
    <div className="max-w-7xl mx-auto px-3 py-4 sm:p-6 lg:p-8 space-y-6 sm:space-y-8">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-bold text-xl shadow-md flex-shrink-0 overflow-hidden">
            {settings?.schoolLogo ? (
              <DriveImage
                src={settings.schoolLogo}
                alt={settings.schoolName || 'Logo Sekolah'}
                className="w-full h-full object-contain bg-white p-1"
              />
            ) : (
              <Shield className="w-6 h-6 text-blue-400" />
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
              Panel Administrator Utama
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Konfigurasi Sekolah, Manajemen Pengguna, Biometric Wajah, dan Database Google Sheets
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(saveStatus === 'saving' || isSavingSettings) && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 font-bold">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Menyimpan...</span>
            </span>
          )}
          {(saveStatus === 'saved' || settingsSaved || savedBadge) && !isSavingSettings && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 font-bold">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Tersimpan</span>
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 font-bold">
              {saveMessage || 'Gagal menyimpan'}
            </span>
          )}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold">
            <Table className="w-3.5 h-3.5 text-emerald-600" />
            <span>Database Tunggal: Google Sheets</span>
          </div>
        </div>
      </div>

      {/* Admin Navigation Pills (Horizontally scrollable on mobile phones) */}
      <div className="flex flex-nowrap sm:flex-wrap overflow-x-auto no-scrollbar gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
        {[
          { id: 'settings', label: 'Pengaturan & Sesi', icon: <Settings className="w-4 h-4" /> },
          { id: 'users', label: 'Pengguna & Akun', icon: <Users className="w-4 h-4" /> },
          { id: 'face_db', label: 'Database Wajah', icon: <Camera className="w-4 h-4" /> },
          { id: 'locations', label: 'Titik Lokasi GPS', icon: <MapPin className="w-4 h-4" /> },
          { id: 'classes', label: 'Kelas & Naik Kelas', icon: <GraduationCap className="w-4 h-4" /> },
          { id: 'students', label: 'Data Siswa', icon: <Users className="w-4 h-4" /> },
          { id: 'bulk_upload', label: 'Upload Massal', icon: <Upload className="w-4 h-4" /> },
          { id: 'id_cards', label: 'Cetak Kartu Siswa', icon: <QrCode className="w-4 h-4" /> },
          { id: 'teacher_recap', label: 'Rekap Presensi Guru', icon: <Briefcase className="w-4 h-4" /> },
          { id: 'audit_log', label: 'Sheet Log', icon: <Shield className="w-4 h-4" /> },
        ].map(item => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id as any)}
            className={`flex-shrink-0 whitespace-nowrap flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === item.id
                ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/25'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Tab 1: Session Rules (Siswa vs Guru) & School System Settings */}
      {activeTab === 'settings' && (
        <div className="space-y-6 max-w-5xl">
          {/* Card 1: Per-Role Attendance Session Rules (Siswa & Guru Terpisah, Auto-Switch 24 Jam, Sheet Baru Per Sesi) */}
          <SessionManagementCard
            sessions={sessions}
            activeStudentSession={activeStudentSession}
            activeTeacherSession={activeTeacherSession}
            wibNowHhMm={wibNowHhMm}
            onRefresh={handleDataMutated}
            onSavedToast={triggerSavedToast}
            onDeletedToast={triggerDeletedToast}
            onErrorToast={triggerErrorToast}
          />

          {/* Card 2: School System Settings */}
          <div className="p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-6">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Pengaturan Umum Sekolah &amp; Toilet</h3>
            <p className="text-xs text-slate-500">
              Identitas sekolah, format jam 24 jam (WIB), batas waktu toilet, dan ambang peringatan BK
            </p>
          </div>

          {settingsSaved && (
            <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2 font-semibold">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <span>Tersimpan! Pengaturan sekolah berhasil diperbarui di Google Sheets.</span>
            </div>
          )}

          {settingsError && (
            <div className="p-3.5 rounded-2xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{settingsError}</span>
            </div>
          )}

          <form onSubmit={handleSaveSettings} className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Nama Sekolah
                </label>
                <input
                  type="text"
                  value={settingsForm.schoolName || ''}
                  onChange={e => updateSettingsField('schoolName', e.target.value)}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Tahun Ajaran
                </label>
                <input
                  type="text"
                  value={settingsForm.academicYear || ''}
                  onChange={e => updateSettingsField('academicYear', e.target.value)}
                  placeholder="2026/2027"
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Alamat Sekolah / Yayasan (Ditampilkan di Aplikasi & Kartu Pelajar)
                </label>
                <input
                  type="text"
                  value={settingsForm.foundationAddress || ''}
                  onChange={e => updateSettingsField('foundationAddress', e.target.value)}
                  placeholder="Jl. Pesantren Mambaul Ulum No. 45, Diwek, Jombang, Jawa Timur 61471"
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Website Sekolah / Yayasan
                </label>
                <input
                  type="text"
                  value={settingsForm.foundationWebsite || ''}
                  onChange={e => updateSettingsField('foundationWebsite', e.target.value)}
                  placeholder="https://mambaululum.sch.id"
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Telepon Sekolah / Yayasan (Otomatis Tampil di Kartu Siswa)
                </label>
                <input
                  type="tel"
                  value={settingsForm.foundationPhone ?? ''}
                  onChange={e => updateSettingsField('foundationPhone', e.target.value)}
                  placeholder="(0321) 876543 / 081234567890"
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2">
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Logo Utama Sekolah / Yayasan (Tersimpan di Google Drive)
                </label>
                <div className="flex items-center gap-2.5 flex-wrap">
                  {settingsForm.schoolLogo ? (
                    <DriveImage
                      src={settingsForm.schoolLogo}
                      alt="Logo Sekolah"
                      className="w-11 h-11 rounded-xl object-contain bg-white border border-slate-200 p-1 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-11 h-11 rounded-xl bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-600 flex items-center justify-center text-[10px] text-slate-400 flex-shrink-0">
                      Kosong
                    </div>
                  )}
                  <label className="flex-1 min-w-[140px] flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold cursor-pointer transition">
                    {uploadingSettingAsset === 'schoolLogo' ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Mengupload ke Drive...</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-3.5 h-3.5" />
                        <span>Upload Logo Sekolah</span>
                      </>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      disabled={Boolean(uploadingSettingAsset || deletingSettingAsset)}
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (f) void handleUploadSettingAsset('schoolLogo', f);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </label>
                  {settingsForm.schoolLogo && (
                    <button
                      type="button"
                      disabled={Boolean(uploadingSettingAsset || deletingSettingAsset)}
                      onClick={() => void handleDeleteSettingAsset('schoolLogo')}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold transition disabled:opacity-60"
                      title="Hapus logo dari Google Drive & Sheets"
                    >
                      {deletingSettingAsset === 'schoolLogo' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      <span>Hapus</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="sm:col-span-2 p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2.5">
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Watermark Background Kartu Global (Tersimpan di Google Drive)
                </label>
                <div className="flex items-center gap-2.5 flex-wrap">
                  {settingsForm.foundationWatermarkUrl ? (
                    <DriveImage
                      src={settingsForm.foundationWatermarkUrl}
                      alt="Watermark Global"
                      className="w-11 h-11 rounded-xl object-contain bg-white border border-slate-200 p-1 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-11 h-11 rounded-xl bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-600 flex items-center justify-center text-[10px] text-slate-400 flex-shrink-0">
                      Kosong
                    </div>
                  )}
                  <label className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold cursor-pointer transition">
                    {uploadingSettingAsset === 'foundationWatermarkUrl' ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Mengupload ke Drive...</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-3.5 h-3.5" />
                        <span>Upload Watermark ke Drive</span>
                      </>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      disabled={Boolean(uploadingSettingAsset || deletingSettingAsset)}
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (f) void handleUploadSettingAsset('foundationWatermarkUrl', f);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </label>
                  {settingsForm.foundationWatermarkUrl && (
                    <button
                      type="button"
                      disabled={Boolean(uploadingSettingAsset || deletingSettingAsset)}
                      onClick={() => void handleDeleteSettingAsset('foundationWatermarkUrl')}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold transition disabled:opacity-60"
                      title="Hapus watermark dari Google Drive & Sheets"
                    >
                      {deletingSettingAsset === 'foundationWatermarkUrl' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      <span>Hapus</span>
                    </button>
                  )}
                  <input
                    type="text"
                    value={settingsForm.foundationWatermarkUrl || ''}
                    onChange={e => updateSettingsField('foundationWatermarkUrl', e.target.value)}
                    placeholder="Atau tempel URL / referensi gas-photo://..."
                    className="flex-1 min-w-[200px] px-3.5 py-2 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
              </div>

              <TimeInput24h
                label="Jam Mulai Default (24 Jam WIB)"
                value={settingsForm.checkInTime || '07:00'}
                onChange={(val) => updateSettingsField('checkInTime', val)}
              />

              <TimeInput24h
                label="Batas Terlambat Default (24 Jam WIB)"
                value={settingsForm.lateCutoffTime || '07:15'}
                onChange={(val) => updateSettingsField('lateCutoffTime', val)}
              />

              <TimeInput24h
                label="Jam Pulang Default (24 Jam WIB)"
                value={settingsForm.checkOutTime || '15:00'}
                onChange={(val) => updateSettingsField('checkOutTime', val)}
              />

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Waktu Izin Toilet BAB (Menit)
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={settingsForm.toiletBabMinutes ?? 10}
                  onChange={e => updateSettingsField('toiletBabMinutes', Number(e.target.value))}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Waktu Izin Toilet BAK (Menit)
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={settingsForm.toiletBakMinutes ?? 5}
                  onChange={e => updateSettingsField('toiletBakMinutes', Number(e.target.value))}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Batas Durasi Toilet Umum (Menit)
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={settingsForm.toiletMaxMinutes || 10}
                  onChange={e => updateSettingsField('toiletMaxMinutes', Number(e.target.value))}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Ambang Peringatan BK: Sering Alpa (Kali)
                </label>
                <input
                  type="number"
                  min="1"
                  value={settingsForm.warningThresholdAbsent || 3}
                  onChange={e => updateSettingsField('warningThresholdAbsent', Number(e.target.value))}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Ambang Peringatan BK: Sering Terlambat (Kali)
                </label>
                <input
                  type="number"
                  min="1"
                  value={settingsForm.warningThresholdLate || 3}
                  onChange={e => updateSettingsField('warningThresholdLate', Number(e.target.value))}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>
            </div>

            <div className="space-y-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsForm.parentNotificationEnabled || false}
                  onChange={e => updateSettingsField('parentNotificationEnabled', e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Kirim Notifikasi Presensi ke Orang Tua / Wali
                </span>
              </label>
            </div>

            <div className="pt-4">
              <button
                type="submit"
                disabled={isSavingSettings}
                className="inline-flex items-center gap-2 px-6 py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-md shadow-blue-500/25 disabled:opacity-60 transition cursor-pointer"
              >
                {isSavingSettings ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Menyimpan...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Simpan Pengaturan Sekolah</span>
                  </>
                )}
              </button>
            </div>
          </form>
          </div>
        </div>
      )}

      {/* Tab 2: Users Management */}
      {activeTab === 'users' && (
        <UserManagementSection
          users={usersList}
          teachers={teachers}
          faceTemplates={faceTemplates}
          classes={classes}
          activeUsers={activeUsers}
          currentUserId={user?.id}
          onRefresh={handleDataMutated}
          onJumpToFaceEnroll={(target) => {
            setPendingFaceTarget(target);
            setActiveTab('face_db');
          }}
          onSavedToast={triggerSavedToast}
          onDeletedToast={triggerDeletedToast}
          onErrorToast={triggerErrorToast}
        />
      )}

      {/* Tab 3: Face Database Registration */}
      {activeTab === 'face_db' && (
        <FaceDatabaseSection
          students={students}
          classes={classes}
          teachers={teachers}
          users={usersList}
          faceTemplates={faceTemplates}
          initialSelection={pendingFaceTarget}
          onClearInitialSelection={() => setPendingFaceTarget(null)}
          onRefresh={handleDataMutated}
          onSavedToast={triggerSavedToast}
          onDeletedToast={triggerDeletedToast}
          onErrorToast={triggerErrorToast}
        />
      )}

      {/* Tab 4: Locations Settings */}
      {activeTab === 'locations' && (
        <LocationsSection
          locations={locations}
          onRefresh={handleDataMutated}
          onSavedToast={triggerSavedToast}
          onDeletedToast={triggerDeletedToast}
          onErrorToast={triggerErrorToast}
        />
      )}

      {/* Tab 5: Classes & Promotion (Naik Kelas) */}
      {activeTab === 'classes' && (
        <ClassesSection
          classes={classes}
          teachers={teachers}
          students={students}
          onRefresh={handleDataMutated}
          onSavedToast={triggerSavedToast}
          onDeletedToast={triggerDeletedToast}
          onErrorToast={triggerErrorToast}
        />
      )}

      {/* Tab 6: Students CRUD */}
      {activeTab === 'students' && (
        <StudentsSection
          students={students}
          classes={classes}
          onRefresh={handleDataMutated}
          onSavedToast={triggerSavedToast}
          onDeletedToast={triggerDeletedToast}
          onErrorToast={triggerErrorToast}
        />
      )}

      {/* Tab 7: Bulk Upload Students */}
      {activeTab === 'bulk_upload' && (
        <BulkUploadSection
          classes={classes}
          onDownloadTemplate={handleDownloadTemplate}
          onRefresh={handleDataMutated}
          onSavedToast={triggerSavedToast}
          onErrorToast={triggerErrorToast}
        />
      )}

      {/* Tab 8: Bulk ID Cards & JPG Generator Multi-Jenjang */}
      {activeTab === 'id_cards' && (
        <StudentCardManager
          students={students}
          classes={classes}
          schoolName={settings?.schoolName || 'Yayasan Mambaul Ulum'}
          schoolAddress={settings?.foundationAddress}
          schoolPhone={settings?.foundationPhone}
          schoolLogo={settings?.schoolLogo}
          foundationWebsite={settings?.foundationWebsite}
          watermarkUrl={settings?.foundationWatermarkUrl}
          faceTemplates={faceTemplates}
          onUpdateSettings={updateSettings}
          onSavedToast={triggerSavedToast}
          initialLevelConfigsJson={settings?.levelConfigsJson}
        />
      )}

      {/* Tab 9: Rekap Presensi Guru (Harian, Pekan, Bulanan - Sinkron Real-Time) */}
      {activeTab === 'teacher_recap' && (
        <TeacherRecapSection serverVersion={serverVersion} teachers={teachers} sessions={sessions} />
      )}

      {/* Tab 10: Sheet Log */}
      {activeTab === 'audit_log' && (
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Riwayat Perubahan Database (Sheet Log)</h3>
            <span className="text-xs text-slate-500">100 Log Terbaru (Format 24 Jam WIB)</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                  <th className="py-3 px-3">Waktu (24J WIB)</th>
                  <th className="py-3 px-3">User</th>
                  <th className="py-3 px-3">Aksi</th>
                  <th className="py-3 px-3">Entitas</th>
                  <th className="py-3 px-3">Rincian Perubahan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {auditLogs.map(log => (
                  <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-3 px-3 font-mono text-slate-400">
                      {formatWibDateTime24(log.createdAt)} WIB
                    </td>
                    <td className="py-3 px-3 font-semibold text-slate-900 dark:text-white">{log.userId}</td>
                    <td className="py-3 px-3">
                      <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-mono text-[10px]">
                        {log.action}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-slate-500">{log.entity}</td>
                    <td className="py-3 px-3 text-slate-700 dark:text-slate-300">{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
};

// -----------------------------------------------------------------------------
// Sub-components for Admin
// -----------------------------------------------------------------------------

const SessionManagementCard: React.FC<{
  sessions: AttendanceSession[];
  activeStudentSession: AttendanceSession | null;
  activeTeacherSession: AttendanceSession | null;
  wibNowHhMm: string;
  onRefresh: () => Promise<void> | void;
  onSavedToast?: (msg: string) => void;
  onDeletedToast?: (msg: string) => void;
  onErrorToast?: (msg: string) => void;
}> = ({
  sessions,
  activeStudentSession,
  activeTeacherSession,
  wibNowHhMm,
  onRefresh,
  onSavedToast,
  onDeletedToast,
  onErrorToast,
}) => {
  const [roleTab, setRoleTab] = useState<SessionTargetType>('student');
  const [editingSession, setEditingSession] = useState<AttendanceSession | null>(null);
  const [showForm, setShowForm] = useState<boolean>(false);
  const [formState, setFormState] = useState<{
    targetType: SessionTargetType;
    name: string;
    startTime: string;
    lateCutoffTime: string;
    endTime: string;
    sheetName: string;
    sortOrder: number;
    isActive: boolean;
  }>({
    targetType: 'student',
    name: '',
    startTime: '06:30',
    lateCutoffTime: '07:15',
    endTime: '12:00',
    sheetName: '',
    sortOrder: 1,
    isActive: true,
  });
  const [sheetEditedManually, setSheetEditedManually] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AttendanceSession | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const filteredSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.targetType === roleTab)),
    [sessions, roleTab]
  );

  const openAddForm = (targetType: SessionTargetType) => {
    const existingCount = sessions.filter((s) => s.targetType === targetType).length;
    const defaultName = targetType === 'student' ? `Sesi Siswa ${existingCount + 1}` : `Sesi Guru ${existingCount + 1}`;
    setEditingSession(null);
    setSheetEditedManually(false);
    setFeedback(null);
    setFormState({
      targetType,
      name: defaultName,
      startTime: existingCount === 0 ? '06:00' : '12:01',
      lateCutoffTime: existingCount === 0 ? '07:15' : '13:00',
      endTime: existingCount === 0 ? '12:00' : '18:00',
      sheetName: generateSessionSheetName(targetType, defaultName),
      sortOrder: existingCount + 1,
      isActive: true,
    });
    setShowForm(true);
  };

  const openEditForm = (ses: AttendanceSession) => {
    setEditingSession(ses);
    setSheetEditedManually(true);
    setFeedback(null);
    setFormState({
      targetType: ses.targetType,
      name: ses.name,
      startTime: ses.startTime,
      lateCutoffTime: ses.lateCutoffTime,
      endTime: ses.endTime,
      sheetName: ses.sheetName,
      sortOrder: ses.sortOrder || 1,
      isActive: ses.isActive !== false,
    });
    setShowForm(true);
  };

  const handleNameChange = (name: string) => {
    setFormState((prev) => ({
      ...prev,
      name,
      sheetName: sheetEditedManually ? prev.sheetName : generateSessionSheetName(prev.targetType, name),
    }));
  };

  const handleSaveSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formState.name.trim()) {
      setFeedback({ type: 'error', text: 'Nama sesi wajib diisi.' });
      return;
    }
    setIsSaving(true);
    setFeedback(null);
    try {
      const payloadData = {
        targetType: formState.targetType,
        name: formState.name.trim(),
        startTime: formState.startTime,
        lateCutoffTime: formState.lateCutoffTime,
        endTime: formState.endTime,
        sheetName: (formState.sheetName || generateSessionSheetName(formState.targetType, formState.name)).trim(),
        sortOrder: Number(formState.sortOrder) || 1,
        isActive: formState.isActive,
      };

      const res = editingSession
        ? await gasPost('updateRecord', {
            entity: 'Sessions',
            id: editingSession.id,
            data: {
              ...payloadData,
              expectedUpdatedAt: editingSession.diubah_pada || editingSession.updatedAt,
            },
          })
        : await gasPost('createRecord', {
            entity: 'Sessions',
            data: payloadData,
          });

      if (res.success) {
        await onRefresh();
        setShowForm(false);
        setEditingSession(null);
        const msg = editingSession
          ? `Peraturan sesi "${payloadData.name}" tersimpan & Sheet "${(res.data as any)?.sheetName || payloadData.sheetName}" disinkronkan.`
          : `Sesi baru "${payloadData.name}" tersimpan beserta Sheet khusus "${(res.data as any)?.sheetName || payloadData.sheetName}".`;
        setFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menyimpan sesi presensi.';
        setFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal menyimpan sesi presensi.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await gasPost('softDeleteRecord', {
        entity: 'Sessions',
        id: deleteTarget.id,
        expectedUpdatedAt: deleteTarget.diubah_pada || deleteTarget.updatedAt,
      });
      if (res.success) {
        await onRefresh();
        const deletedName = deleteTarget.name;
        setDeleteTarget(null);
        const msg = `Sesi "${deletedName}" & sheet-nya telah dihapus.`;
        setFeedback({ type: 'success', text: msg });
        onDeletedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menghapus sesi.';
        setFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal menghapus sesi.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Layers className="w-5 h-5 text-blue-600" />
            <span>Peraturan Sesi Presensi Siswa &amp; Guru (24 Jam WIB)</span>
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Aturan sesi siswa dan guru terpisah. Setiap sesi otomatis beralih sesuai jam 24 jam (WIB) dan memiliki Sheet Google tersendiri agar presensi berdiri sendiri tanpa bercampur.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 font-mono font-bold text-slate-700 dark:text-slate-200">
            Sekarang: {wibNowHhMm} WIB
          </span>
          <button
            type="button"
            onClick={() => openAddForm(roleTab)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Sesi {roleTab === 'student' ? 'Siswa' : 'Guru'}</span>
          </button>
        </div>
      </div>

      {/* Role Switcher: Sesi Siswa vs Sesi Guru */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
        <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={() => {
              setRoleTab('student');
              setShowForm(false);
            }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition ${
              roleTab === 'student'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <GraduationCap className="w-4 h-4" />
            <span>Sesi Siswa ({sessions.filter((s) => s.targetType === 'student').length})</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setRoleTab('teacher');
              setShowForm(false);
            }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition ${
              roleTab === 'teacher'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <Briefcase className="w-4 h-4" />
            <span>Sesi Guru ({sessions.filter((s) => s.targetType === 'teacher').length})</span>
          </button>
        </div>

        <div className="text-xs text-slate-500">
          {roleTab === 'student' ? (
            <span>
              Sedang Aktif:{' '}
              <strong className="text-emerald-600 dark:text-emerald-400">
                {activeStudentSession ? `${activeStudentSession.name} (${activeStudentSession.startTime}–${activeStudentSession.endTime} WIB)` : 'Di luar jadwal sesi siswa'}
              </strong>
            </span>
          ) : (
            <span>
              Sedang Aktif:{' '}
              <strong className="text-emerald-600 dark:text-emerald-400">
                {activeTeacherSession ? `${activeTeacherSession.name} (${activeTeacherSession.startTime}–${activeTeacherSession.endTime} WIB)` : 'Di luar jadwal sesi guru'}
              </strong>
            </span>
          )}
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-2xl border text-xs flex items-center gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Session Add/Edit Form */}
      {showForm && (
        <form
          onSubmit={handleSaveSession}
          className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-black text-slate-900 dark:text-white">
              {editingSession ? `Edit Sesi: ${editingSession.name}` : `Tambah Sesi ${formState.targetType === 'student' ? 'Siswa' : 'Guru'} Baru`}
            </h4>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setEditingSession(null);
              }}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-white"
            >
              Tutup
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Peruntukan Sesi
              </label>
              <select
                value={formState.targetType}
                disabled={Boolean(editingSession)}
                onChange={(e) => {
                  const nextType = e.target.value as SessionTargetType;
                  setFormState((prev) => ({
                    ...prev,
                    targetType: nextType,
                    sheetName: sheetEditedManually ? prev.sheetName : generateSessionSheetName(nextType, prev.name),
                  }));
                }}
                className="w-full px-3.5 py-2.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl disabled:opacity-60"
              >
                <option value="student">Presensi Siswa</option>
                <option value="teacher">Presensi Guru</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Nama Sesi
              </label>
              <input
                type="text"
                value={formState.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Contoh: Sesi Pagi / Sesi Ekskul"
                className="w-full px-3.5 py-2.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Nama Sheet Khusus Sesi
              </label>
              <input
                type="text"
                value={formState.sheetName}
                onChange={(e) => {
                  setSheetEditedManually(true);
                  setFormState((prev) => ({ ...prev, sheetName: e.target.value }));
                }}
                placeholder="Presensi_Siswa_Sesi_Pagi"
                className="w-full px-3.5 py-2.5 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl"
                required
              />
            </div>

            <TimeInput24h
              label="Jam Mulai Sesi (24J WIB)"
              value={formState.startTime}
              onChange={(val) => setFormState((prev) => ({ ...prev, startTime: val }))}
            />

            <TimeInput24h
              label="Batas Tepat Waktu / Cutoff (24J WIB)"
              value={formState.lateCutoffTime}
              onChange={(val) => setFormState((prev) => ({ ...prev, lateCutoffTime: val }))}
            />

            <TimeInput24h
              label="Jam Selesai Sesi (24J WIB)"
              value={formState.endTime}
              onChange={(val) => setFormState((prev) => ({ ...prev, endTime: val }))}
            />

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Urutan Prioritas
              </label>
              <input
                type="number"
                min={1}
                max={99}
                value={formState.sortOrder}
                onChange={(e) => setFormState((prev) => ({ ...prev, sortOrder: Number(e.target.value) || 1 }))}
                className="w-full px-3.5 py-2.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl"
              />
            </div>

            <div className="sm:col-span-2 flex items-end pb-2">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={formState.isActive}
                  onChange={(e) => setFormState((prev) => ({ ...prev, isActive: e.target.checked }))}
                  className="rounded text-blue-600 w-4 h-4"
                />
                <span>Aktifkan Sesi &amp; Peralihan Otomatis (24 Jam WIB)</span>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setEditingSession(null);
              }}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-sm disabled:opacity-60 transition cursor-pointer"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Menyimpan...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{editingSession ? 'Simpan Perubahan Sesi' : 'Simpan & Buat Sheet Baru'}</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Session List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredSessions.length === 0 ? (
          <div className="md:col-span-2 py-8 text-center text-xs text-slate-400 border border-dashed border-slate-200 dark:border-slate-700 rounded-2xl">
            Belum ada sesi {roleTab === 'student' ? 'siswa' : 'guru'} yang terdaftar. Klik tombol Tambah Sesi di atas.
          </div>
        ) : (
          filteredSessions.map((ses) => {
            const isRunningNow =
              roleTab === 'student'
                ? activeStudentSession?.id === ses.id
                : activeTeacherSession?.id === ses.id;
            return (
              <div
                key={ses.id}
                className={`p-4 rounded-2xl border space-y-3 transition ${
                  isRunningNow
                    ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-700'
                    : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-black text-slate-900 dark:text-white">{ses.name}</span>
                      {isRunningNow && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[10px] font-bold">
                          <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                          Aktif Otomatis Sekarang
                        </span>
                      )}
                      {ses.isActive === false && (
                        <span className="px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-bold">
                          Nonaktif
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                      Sheet Google: <strong className="text-slate-700 dark:text-slate-200">{ses.sheetName}</strong>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => openEditForm(ses)}
                      className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-blue-600 hover:bg-blue-50 transition"
                      title="Edit Peraturan Sesi"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(ses)}
                      className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-red-600 hover:bg-red-50 transition"
                      title="Hapus Sesi"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-700">
                    <div className="text-slate-400">Jam Mulai</div>
                    <div className="font-mono font-bold text-slate-900 dark:text-white">{ses.startTime} WIB</div>
                  </div>
                  <div className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-700">
                    <div className="text-slate-400">Batas Cutoff</div>
                    <div className="font-mono font-bold text-amber-600 dark:text-amber-400">{ses.lateCutoffTime} WIB</div>
                  </div>
                  <div className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-700">
                    <div className="text-slate-400">Jam Selesai</div>
                    <div className="font-mono font-bold text-slate-900 dark:text-white">{ses.endTime} WIB</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {deleteTarget && (
        <ConfirmModal
          isOpen={Boolean(deleteTarget)}
          title={`Hapus Sesi "${deleteTarget.name}"?`}
          message={`Aturan sesi "${deleteTarget.name}" akan dihapus (soft delete). Riwayat sheet "${deleteTarget.sheetName}" di Google Spreadsheet tidak akan hilang.`}
          confirmLabel="Ya, Hapus Sesi"
          isLoading={isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
};

function defaultSubjectLabelForRole(role: string): string {
  switch (String(role || '').toLowerCase()) {
    case 'kepala_sekolah':
      return 'Kepala Sekolah';
    case 'admin':
      return 'Administrator / Staf';
    case 'wali_kelas':
      return 'Wali Kelas';
    case 'bk':
      return 'Guru BK';
    case 'kesiswaan':
      return 'Staf Kesiswaan';
    case 'guru':
      return 'Guru Mapel';
    default:
      return 'Guru / Staf';
  }
}

function formatRoleDisplayLabel(role: string): string {
  switch (String(role || '').toLowerCase()) {
    case 'kepala_sekolah':
      return 'Kepala Sekolah';
    case 'wali_kelas':
      return 'Wali Kelas';
    case 'bk':
      return 'Guru BK';
    case 'kesiswaan':
      return 'Staf Kesiswaan';
    case 'guru':
      return 'Guru';
    case 'admin':
      return 'Admin';
    default:
      return role || 'Staf';
  }
}

function findMatchingTeacherForUser(u: any, teachersList: Teacher[]): Teacher | undefined {
  if (!u) return undefined;
  const userTeacherId = String(u.teacherId || '').trim();
  const userNip = String(u.nip || '').trim();
  const userEmail = String(u.email || '').trim().toLowerCase();
  const userName = String(u.name || '').trim().toLowerCase();

  return teachersList.find((t) => {
    if (userTeacherId && t.id === userTeacherId) return true;
    const tNip = String(t.nip || '').trim();
    const tEmail = String(t.email || '').trim().toLowerCase();
    const tName = String(t.name || '').trim().toLowerCase();
    if (userNip && tNip && tNip === userNip) return true;
    if (userEmail && tEmail && tEmail === userEmail) return true;
    if (userName && tName && tName === userName) return true;
    return false;
  });
}

// Face Database Enrollment
const FaceDatabaseSection: React.FC<{
  students: Student[];
  classes: SchoolClass[];
  teachers: Teacher[];
  users: any[];
  faceTemplates: FaceTemplate[];
  initialSelection?: { personType: 'student' | 'teacher'; personId: string } | null;
  onClearInitialSelection?: () => void;
  onRefresh: () => Promise<void> | void;
  onSavedToast?: (msg: string) => void;
  onDeletedToast?: (msg: string) => void;
  onErrorToast?: (msg: string) => void;
}> = ({
  students,
  classes,
  teachers,
  users,
  faceTemplates,
  initialSelection,
  onClearInitialSelection,
  onRefresh,
  onSavedToast,
  onDeletedToast,
  onErrorToast,
}) => {
  const [selectedPersonType, setSelectedPersonType] = useState<'student' | 'teacher'>(
    initialSelection?.personType || 'student'
  );
  const [selectedPersonId, setSelectedPersonId] = useState<string>(
    initialSelection?.personId || ''
  );
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [isRequestingCamera, setIsRequestingCamera] = useState<boolean>(true);
  const [cameraError, setCameraError] = useState<{ title: string; message: string } | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [searchList, setSearchList] = useState<string>('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; updatedAt?: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [mirrorPreview, setMirrorPreview] = useState<boolean>(true);
  const [needsPlayTap, setNeedsPlayTap] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const photoUploadRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef<boolean>(true);
  const cameraExpectedActiveRef = useRef<boolean>(true);
  const facingModeRef = useRef<'user' | 'environment'>('user');
  facingModeRef.current = facingMode;

  useEffect(() => {
    if (initialSelection?.personId) {
      setSelectedPersonType(initialSelection.personType);
      setSelectedPersonId(initialSelection.personId);
      setMessage(null);
      onClearInitialSelection?.();
    }
  }, [initialSelection, onClearInitialSelection]);

  const enrolledPersonIds = useMemo(
    () => new Set(faceTemplates.map((f) => f.personId)),
    [faceTemplates]
  );

  // Gabungkan data Teachers dan seluruh akun pengguna aktif (Guru, Kepsek, Wali Kelas, BK, Kesiswaan, Admin)
  // agar pengguna yang baru ditambah atau pengguna lama langsung muncul & siap direkam wajahnya.
  const teacherStaffList = useMemo(() => {
    const activeNonSuperadminUsers = (users || []).filter(
      (u) =>
        u &&
        u.isActive !== false &&
        String(u.role || '').toLowerCase() !== 'superadmin' &&
        String(u.username || '').toLowerCase() !== 'superadmin'
    );

    const list: Array<
      Teacher & { role?: string; linkedUserId?: string; isVirtualUserOnly?: boolean }
    > = teachers
      .filter((t) => t.isActive !== false)
      .map((t) => {
        const matchedUser = activeNonSuperadminUsers.find((u) => {
          const uTchId = String(u.teacherId || '').trim();
          const uNip = String(u.nip || '').trim();
          const uEmail = String(u.email || '').trim().toLowerCase();
          const uName = String(u.name || '').trim().toLowerCase();
          const tNip = String(t.nip || '').trim();
          const tEmail = String(t.email || '').trim().toLowerCase();
          const tName = String(t.name || '').trim().toLowerCase();
          return (
            (uTchId && uTchId === t.id) ||
            (uNip && tNip && uNip === tNip) ||
            (uEmail && tEmail && uEmail === tEmail) ||
            (uName && tName && uName === tName)
          );
        });
        return {
          ...t,
          role: matchedUser?.role,
          linkedUserId: matchedUser?.id,
          isVirtualUserOnly: false,
        };
      });

    for (const u of activeNonSuperadminUsers) {
      const existing = findMatchingTeacherForUser(u, teachers);
      if (!existing) {
        list.push({
          id: u.id,
          nip: u.nip || '-',
          name: u.name,
          email: u.email || '',
          phone: '',
          subject: u.subject || defaultSubjectLabelForRole(u.role),
          isActive: true,
          createdAt: u.createdAt || '',
          updatedAt: u.updatedAt || '',
          updatedBy: u.updatedBy || 'SYSTEM',
          role: u.role,
          linkedUserId: u.id,
          isVirtualUserOnly: true,
        });
      }
    }

    return list;
  }, [teachers, users]);

  const findPersonTemplate = useCallback(
    (person: any): FaceTemplate | undefined => {
      if (!person) return undefined;
      return faceTemplates.find(
        (f) =>
          f.personId === person.id ||
          (person.linkedUserId && f.personId === person.linkedUserId)
      );
    },
    [faceTemplates]
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!areFaceModelsLoaded()) {
      loadFaceDetectionModels().catch(() => {});
    }

    // Request camera permission & open camera immediately when Perekaman Wajah opens
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

  // Ensure stream always binds even if <CameraPreviewStage> mounts a render after startCamera starts
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
    setMessage(null);
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
        loadFaceDetectionModels().catch(() => {});
      }
      // Invoke getUserMedia synchronously in caller callstack to guarantee PWA/mobile permission prompt
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
      }
      if (!mountedRef.current) return;
      setIsRequestingCamera(false);
      setIsCameraActive(true);
    } catch (e: any) {
      if (!mountedRef.current || e?.message === 'Camera request superseded') return;
      cameraExpectedActiveRef.current = false;
      setIsRequestingCamera(false);
      setIsCameraActive(false);
      setNeedsPlayTap(false);
      const parsed = parseCameraError(e);
      setCameraError(parsed);
      setMessage({ type: 'error', text: `${parsed.title}: ${parsed.message}` });
    }
  };

  const stopCamera = () => {
    cameraExpectedActiveRef.current = false;
    if (streamRef.current) {
      stopMediaStreamSafely(streamRef.current);
      streamRef.current = null;
    }
    setIsRequestingCamera(false);
    setIsCameraActive(false);
    setNeedsPlayTap(false);
  };

  const switchCamera = () => {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    setMirrorPreview(nextMode === 'user');
    if (isCameraActive) {
      void startCamera(nextMode, true);
    }
  };

  const saveDescriptorAndPortrait = async (
    descriptor: number[],
    sourceEl: HTMLVideoElement | HTMLImageElement,
    sourceWidth: number,
    sourceHeight: number
  ) => {
    let uploadedFileId: string | undefined;
    let targetPersonId = selectedPersonId;

    // Jika akun guru/kepsek/staf belum punya baris di sheet Teachers (mis. akun bawaan/sebelum redeploy GAS),
    // buatkan baris Teachers otomatis terlebih dahulu agar data wajah & presensi terhubung permanen.
    const selectedStaffEntry =
      selectedPersonType === 'teacher'
        ? teacherStaffList.find(
            (t) => t.id === selectedPersonId || t.linkedUserId === selectedPersonId
          )
        : undefined;

    if (selectedPersonType === 'teacher' && selectedStaffEntry?.isVirtualUserOnly) {
      try {
        const ensureTeacherRes = await gasPost<any>('createRecord', {
          entity: 'Teachers',
          data: {
            nip:
              selectedStaffEntry.nip && selectedStaffEntry.nip !== '-'
                ? selectedStaffEntry.nip
                : '',
            name: selectedStaffEntry.name,
            email: selectedStaffEntry.email || '',
            phone: selectedStaffEntry.phone || '',
            subject:
              selectedStaffEntry.subject ||
              defaultSubjectLabelForRole(selectedStaffEntry.role || ''),
            isActive: true,
          },
        });
        if (ensureTeacherRes?.success && ensureTeacherRes?.data?.id) {
          targetPersonId = ensureTeacherRes.data.id;
          setSelectedPersonId(targetPersonId);
        }
      } catch (ensureErr) {
        console.warn('Auto-create Teachers record fallback skipped:', ensureErr);
      }
    }

    // Upload foto wajah / pas foto latar biru secara privat ke folder Drive via DriveApp
    if (sourceWidth > 0 && sourceHeight > 0) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 400; // 3:4 portrait
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = selectedPersonType === 'student' ? '#1e40af' : '#0f172a';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const cropW = Math.min(sourceWidth, sourceHeight * 0.75);
          const cropH = cropW * (4 / 3);
          const startX = Math.max(0, (sourceWidth - cropW) / 2);
          const startY = Math.max(0, (sourceHeight - cropH) / 2);

          ctx.drawImage(sourceEl, startX, startY, cropW, Math.min(cropH, sourceHeight - startY), 0, 0, 300, 400);
          const portraitDataUrl = canvas.toDataURL('image/jpeg', 0.9);

          let neatFileName = `${selectedPersonType}_${targetPersonId}.jpg`;
          if (selectedPersonType === 'student') {
            const stObj = students.find(s => s.id === targetPersonId);
            if (stObj) {
              const clsObj = classes.find(c => c.id === stObj.classId);
              const clsPart = (clsObj?.name || stObj.level || 'Siswa').replace(/[\\/:*?"<>|]+/g, ' ').trim();
              const nisPart = (stObj.nis || stObj.id).replace(/[\\/:*?"<>|]+/g, ' ').trim();
              const namePart = stObj.name.replace(/[\\/:*?"<>|]+/g, ' ').trim();
              neatFileName = `${clsPart} - ${nisPart} - ${namePart} - Wajah.jpg`;
            }
          } else {
            const tchObj = selectedStaffEntry || teachers.find(t => t.id === targetPersonId);
            if (tchObj) {
              const nipPart = (tchObj.nip && tchObj.nip !== '-' ? tchObj.nip : 'TanpaNIP').replace(/[\\/:*?"<>|]+/g, ' ').trim();
              const namePart = tchObj.name.replace(/[\\/:*?"<>|]+/g, ' ').trim();
              neatFileName = `${nipPart} - ${namePart} - Wajah.jpg`;
            }
          }

          const uploadRes = await gasPost<{ fileId: string; fileName?: string; folderName?: string }>('uploadPhoto', {
            base64Data: portraitDataUrl,
            mimeType: 'image/jpeg',
            fileName: neatFileName,
            personType: selectedPersonType,
            personId: targetPersonId,
            targetType: selectedPersonType,
            targetId: targetPersonId,
            purpose: 'face',
          });
          if (uploadRes.success && uploadRes.fileId) {
            uploadedFileId = uploadRes.fileId;
          }
        }
      } catch (photoErr) {
        console.warn('Could not upload face portrait to Drive:', photoErr);
      }
    }

    try {
      const res = await gasPost('saveFaceTemplate', {
        personId: targetPersonId,
        personType: selectedPersonType,
        descriptor,
        photoFileId: uploadedFileId,
      });

      if (res.success) {
        stopCamera();
        await onRefresh();
        const msg = 'Wajah & foto Drive privat tersimpan dan langsung tersinkron!';
        setMessage({
          type: 'success',
          text: msg,
        });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menyimpan template wajah.';
        setMessage({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal menyimpan template wajah.';
      setMessage({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    }
  };

  // Capture face descriptor from live camera and save vector to server
  const handleEnrollFace = async () => {
    if (!selectedPersonId || !videoRef.current) return;
    setIsCapturing(true);
    setMessage(null);

    try {
      const descriptor = await detectSingleFaceDescriptor(videoRef.current);
      if (!descriptor) {
        setMessage({
          type: 'error',
          text: 'Wajah tidak terdeteksi jelas. Posisikan wajah di tengah kamera.',
        });
        return;
      }

      const vw = videoRef.current.videoWidth || 640;
      const vh = videoRef.current.videoHeight || 480;
      await saveDescriptorAndPortrait(descriptor, videoRef.current, vw, vh);
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Gagal menangkap wajah dari kamera.' });
    } finally {
      setIsCapturing(false);
    }
  };

  // Upload photo file and extract face descriptor directly
  const handleUploadPhotoEnroll = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedPersonId) return;

    setIsCapturing(true);
    setMessage(null);

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
      });

      const descriptor = await detectFaceDescriptorFromImage(img);
      if (!descriptor) {
        setMessage({
          type: 'error',
          text: 'Wajah tidak terdeteksi jelas pada foto. Pastikan foto menghadap depan dan cukup terang.',
        });
        return;
      }

      await saveDescriptorAndPortrait(descriptor, img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Gagal memproses foto wajah.' });
    } finally {
      setIsCapturing(false);
      if (photoUploadRef.current) {
        photoUploadRef.current.value = '';
      }
    }
  };

  const displayList = selectedPersonType === 'student'
    ? students.filter(s =>
        !searchList ||
        s.name.toLowerCase().includes(searchList.toLowerCase()) ||
        s.nis.toLowerCase().includes(searchList.toLowerCase())
      )
    : teacherStaffList.filter(t => {
        const q = searchList.toLowerCase();
        return (
          !q ||
          t.name.toLowerCase().includes(q) ||
          String(t.nip || '').toLowerCase().includes(q) ||
          String(t.subject || '').toLowerCase().includes(q) ||
          formatRoleDisplayLabel(t.role || '').toLowerCase().includes(q)
        );
      });

  const studentTemplatesCount = faceTemplates.filter(f => !f.personType || f.personType === 'student').length;
  const teacherTemplatesCount = faceTemplates.filter(f => f.personType === 'teacher').length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Enrollment Card */}
      <div className="lg:col-span-6 p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Pendaftaran Wajah Baru (Biometric)</h3>
          <p className="text-xs text-slate-500">
            Vektor wajah 128 angka otomatis tersinkron real-time ke Kios Presensi Siswa, Presensi Guru, Kepala Sekolah &amp; Staf.
          </p>
        </div>

        {message && (
          <div
            className={`p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${
              message.type === 'error'
                ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
                : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedPersonType('student');
                setSelectedPersonId('');
              }}
              className={`py-2 text-xs font-bold rounded-xl border ${
                selectedPersonType === 'student'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              Wajah Siswa ({studentTemplatesCount})
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedPersonType('teacher');
                setSelectedPersonId('');
              }}
              className={`py-2 text-xs font-bold rounded-xl border ${
                selectedPersonType === 'teacher'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              Guru, Kepsek &amp; Staf ({teacherTemplatesCount})
            </button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Pilih {selectedPersonType === 'student' ? 'Siswa' : 'Guru / Kepala Sekolah / Staf'}
            </label>
            <select
              value={selectedPersonId}
              onChange={e => setSelectedPersonId(e.target.value)}
              className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            >
              <option value="">-- Pilih Nama --</option>
              {selectedPersonType === 'student'
                ? students.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.nis} - {s.name} {enrolledPersonIds.has(s.id) ? '✓ (Terdaftar)' : '✗ (Belum)'}
                    </option>
                  ))
                : teacherStaffList.map(t => {
                    const isEnrolled = Boolean(findPersonTemplate(t));
                    const roleBadge = t.role
                      ? formatRoleDisplayLabel(t.role)
                      : t.subject || 'Guru';
                    return (
                      <option key={t.id} value={t.id}>
                        {t.name} ({roleBadge}) {isEnrolled ? '✓ (Terdaftar)' : '✗ (Belum)'}
                      </option>
                    );
                  })}
            </select>
          </div>

          {/* Camera preview */}
          <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 min-h-[340px] flex items-center justify-center">
            {isCameraActive && (
              <CameraPreviewStage
                videoRef={videoRef}
                isActive={isCameraActive}
                showGuideFrame
                mirrorPreview={mirrorPreview}
                needsPlayTap={needsPlayTap}
                onTapToPlay={() => {
                  void videoRef.current?.play().then(() => setNeedsPlayTap(false)).catch(() => {});
                }}
                maxHeightClass="h-[50dvh] min-h-[340px] max-h-[540px] sm:h-[440px]"
              >
                <div className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-center justify-between gap-2 pointer-events-auto">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/65 backdrop-blur-md text-white text-[11px] font-medium border border-white/10">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isRequestingCamera ? 'bg-sky-400 animate-pulse' : 'bg-emerald-500 animate-pulse'
                      }`}
                    />
                    <span>
                      {isRequestingCamera
                        ? 'Meminta izin akses kamera...'
                        : `Kamera Aktif (${mirrorPreview ? 'Kanan di Kanan' : 'Sensor Asli'})`}
                    </span>
                  </div>
                  {!selectedPersonId && (
                    <div className="px-2.5 py-1 rounded-lg bg-amber-500/90 text-white text-[10px] font-bold shadow">
                      Pilih nama {selectedPersonType === 'student' ? 'siswa' : 'guru'} di atas sebelum simpan
                    </div>
                  )}
                </div>

                {isRequestingCamera && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/75 backdrop-blur-xs p-5 text-center space-y-3">
                    <Camera className="w-9 h-9 text-sky-400 animate-pulse" />
                    <div className="space-y-1 max-w-xs">
                      <div className="text-xs font-bold text-white">Meminta Izin Pengaktifan Kamera</div>
                      <p className="text-[11px] text-slate-300">
                        Klik &ldquo;Izinkan / Allow&rdquo; pada dialog perangkat atau ketuk tombol di bawah untuk memunculkan izin kamera.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void startCamera(undefined, true)}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow cursor-pointer transition"
                    >
                      Izinkan &amp; Nyalakan Kamera
                    </button>
                  </div>
                )}
              </CameraPreviewStage>
            )}
            {!isCameraActive && (
              <div className="text-center p-6 space-y-3 max-w-sm">
                <Camera className="w-10 h-10 text-blue-400 mx-auto" />
                <p className="text-xs text-slate-300">
                  {cameraError
                    ? 'Akses kamera belum aktif. Ketuk tombol di bawah untuk memunculkan dialog izin kamera pada perangkat ini.'
                    : 'Nyalakan kamera untuk merekam wajah secara langsung atau upload foto wajah.'}
                </p>
                {cameraError && (
                  <div className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-left text-[11px] text-red-200 space-y-1">
                    <div className="font-bold text-red-100">{cameraError.title}</div>
                    <div>{cameraError.message}</div>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => void startCamera(undefined, true)}
                    disabled={isCapturing}
                    className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>{cameraError ? 'Izinkan & Coba Lagi' : 'Nyalakan Kamera'}</span>
                  </button>
                  <label
                    className={`px-4 py-2 text-xs font-bold rounded-xl border border-slate-600 text-slate-200 hover:bg-slate-800 cursor-pointer transition inline-flex items-center gap-1.5 ${
                      !selectedPersonId || isCapturing ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    {isCapturing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>{isCapturing ? 'Menyimpan Foto...' : 'Upload Foto Wajah'}</span>
                    <input
                      ref={photoUploadRef}
                      type="file"
                      accept="image/*"
                      disabled={!selectedPersonId || isCapturing}
                      onChange={handleUploadPhotoEnroll}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {isCameraActive && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleEnrollFace}
                disabled={!selectedPersonId || isCapturing || isRequestingCamera}
                className="flex-1 py-3 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow transition inline-flex items-center justify-center gap-2 disabled:opacity-60 cursor-pointer"
                title={!selectedPersonId ? 'Pilih nama siswa atau guru di atas terlebih dahulu' : 'Rekam wajah dan simpan vektor'}
              >
                {isCapturing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Menyimpan Vektor Wajah...</span>
                  </>
                ) : !selectedPersonId ? (
                  <>
                    <AlertCircle className="w-4 h-4" />
                    <span>Pilih Nama Siswa / Guru Dulu</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Ambil Foto &amp; Simpan Vektor</span>
                  </>
                )}
              </button>
              <label
                className={`px-3.5 py-3 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer transition inline-flex items-center gap-1.5 ${
                  !selectedPersonId || isCapturing ? 'opacity-50 pointer-events-none' : ''
                }`}
                title="Atau upload file foto wajah"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Foto</span>
                <input
                  ref={photoUploadRef}
                  type="file"
                  accept="image/*"
                  disabled={!selectedPersonId || isCapturing}
                  onChange={handleUploadPhotoEnroll}
                  className="hidden"
                />
              </label>
              <button
                type="button"
                onClick={() => setMirrorPreview(v => !v)}
                className="px-3.5 py-3 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
                title="Sesuaikan orientasi preview tanpa mengubah gambar asli AI"
              >
                {mirrorPreview ? 'Orientasi: Kanan=Kanan' : 'Orientasi: Sensor Asli'}
              </button>
              <button
                type="button"
                onClick={switchCamera}
                className="px-4 py-3 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
              >
                Ganti Kamera
              </button>
              <button
                type="button"
                onClick={stopCamera}
                className="px-4 py-3 text-xs font-semibold rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
              >
                Tutup
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right List: Status Terdaftar / Belum */}
      <div className="lg:col-span-6 p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-base font-bold text-slate-900 dark:text-white">
            Database Wajah {selectedPersonType === 'student' ? 'Siswa' : 'Guru, Kepsek & Staf'} ({selectedPersonType === 'student' ? studentTemplatesCount : teacherTemplatesCount} Terdaftar)
          </h3>
          <input
            type="text"
            value={searchList}
            onChange={e => setSearchList(e.target.value)}
            placeholder={selectedPersonType === 'student' ? 'Cari siswa / NIS...' : 'Cari guru, kepsek, atau NIP...'}
            className="px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
          />
        </div>

        <div className="space-y-2 max-h-[500px] overflow-y-auto">
          {displayList.map((person: any) => {
            const template = findPersonTemplate(person);
            const isEnrolled = Boolean(template);
            const isSelected = selectedPersonId === person.id;
            const roleOrSubject =
              selectedPersonType === 'student'
                ? 'Siswa'
                : person.role
                  ? `${formatRoleDisplayLabel(person.role)}${person.subject && person.subject !== formatRoleDisplayLabel(person.role) ? ` (${person.subject})` : ''}`
                  : person.subject || 'Guru';
            const codeLabel =
              selectedPersonType === 'student'
                ? `NIS: ${person.nis} • Siswa`
                : `NIP: ${person.nip || '-'} • ${roleOrSubject}`;
            return (
              <div
                key={person.id}
                className={`p-3 rounded-xl border flex items-center justify-between gap-2 text-xs transition ${
                  isSelected
                    ? 'bg-blue-50/80 dark:bg-blue-950/40 border-blue-300 dark:border-blue-800'
                    : 'bg-slate-50 dark:bg-slate-800/60 border-slate-100 dark:border-slate-800'
                }`}
              >
                <div className="min-w-0">
                  <div className="font-bold text-slate-900 dark:text-white truncate">{person.name}</div>
                  <div className="text-[11px] text-slate-400 truncate">{codeLabel}</div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span
                    className={`px-2 py-0.5 rounded-md font-semibold text-[10px] ${
                      isEnrolled
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                    }`}
                  >
                    {isEnrolled ? 'Terdaftar & Sinkron' : 'Belum'}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPersonId(person.id);
                      setMessage(null);
                      if (!isCameraActive && !isRequestingCamera) {
                        void startCamera(undefined, true);
                      }
                    }}
                    className={`px-2.5 py-1 rounded-lg font-bold text-[10px] transition cursor-pointer ${
                      isSelected
                        ? 'bg-blue-600 text-white'
                        : 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300'
                    }`}
                    title={`Pilih ${person.name} untuk rekam wajah`}
                  >
                    {isSelected ? 'Terpilih' : isEnrolled ? 'Perbarui' : 'Rekam'}
                  </button>

                  {template && (
                    <button
                      onClick={() =>
                        setDeleteTarget({
                          id: template.id,
                          name: person.name,
                          updatedAt: template.diubah_pada || template.updatedAt,
                        })
                      }
                      className="p-1 text-slate-400 hover:text-red-600 transition"
                      title="Hapus template wajah"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Hapus Data Wajah"
        message={`Hapus data wajah milik ${deleteTarget?.name || ''}? Pengguna harus mendaftar ulang jika ingin presensi wajah.`}
        confirmLabel="Ya, Hapus"
        isLoading={isDeleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setIsDeleting(true);
          try {
            const res = await gasPost('softDeleteRecord', {
              entity: 'FaceTemplates',
              id: deleteTarget.id,
              expectedUpdatedAt: deleteTarget.updatedAt,
            });
            if (!res?.success) {
              throw new Error(res?.error || 'Gagal menghapus data wajah di server.');
            }
            await onRefresh();
            const deletedName = deleteTarget.name;
            setDeleteTarget(null);
            const msg = `Data wajah & foto Drive milik ${deletedName} berhasil dihapus.`;
            setMessage({ type: 'success', text: msg });
            onDeletedToast?.(msg);
          } catch (err: any) {
            const errMsg = err?.message || 'Gagal menghapus data wajah.';
            setMessage({ type: 'error', text: errMsg });
            setDeleteTarget(null);
            onErrorToast?.(errMsg);
          } finally {
            setIsDeleting(false);
          }
        }}
      />
    </div>
  );
};

// Users Management Section
const UserManagementSection: React.FC<{
  users: any[];
  teachers: Teacher[];
  faceTemplates: FaceTemplate[];
  classes: SchoolClass[];
  activeUsers: Array<{ userId: string; activeTab: string; deviceLabel: string }>;
  currentUserId?: string;
  onRefresh: () => Promise<void> | void;
  onJumpToFaceEnroll?: (target: { personType: 'student' | 'teacher'; personId: string }) => void;
  onSavedToast?: (msg: string) => void;
  onDeletedToast?: (msg: string) => void;
  onErrorToast?: (msg: string) => void;
}> = ({
  users,
  teachers,
  faceTemplates,
  classes,
  activeUsers,
  currentUserId,
  onRefresh,
  onJumpToFaceEnroll,
  onSavedToast,
  onDeletedToast,
  onErrorToast,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'kepala_sekolah' | 'wali_kelas' | 'bk' | 'kesiswaan' | 'guru'>('guru');
  const [classId, setClassId] = useState('');
  const [email, setEmail] = useState('');
  const [nip, setNip] = useState('');
  const [subject, setSubject] = useState('');
  const [userFeedback, setUserFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<{ id: string; name: string; diubah_pada?: string } | null>(null);
  const [resetNewPassword, setResetNewPassword] = useState('');
  const createFormRef = useRef<HTMLFormElement | null>(null);

  // Edit User Modal state
  const [editingUser, setEditingUser] = useState<any | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    username: string;
    email: string;
    role: 'admin' | 'kepala_sekolah' | 'wali_kelas' | 'bk' | 'kesiswaan' | 'guru';
    classId: string;
    nip: string;
    subject: string;
    password: string;
    isActive: boolean;
  }>({
    name: '',
    username: '',
    email: '',
    role: 'guru',
    classId: '',
    nip: '',
    subject: '',
    password: '',
    isActive: true,
  });

  // Loading states
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [togglingUserId, setTogglingUserId] = useState<string | null>(null);
  const [ensuringFaceUserId, setEnsuringFaceUserId] = useState<string | null>(null);
  const [deleteUserTarget, setDeleteUserTarget] = useState<any | null>(null);
  const [isDeletingUser, setIsDeletingUser] = useState(false);

  const onlineUserIds = new Set(activeUsers.map(a => a.userId));
  const visibleUsers = useMemo(
    () =>
      users.filter(
        (u) =>
          String(u.role || '').toLowerCase() !== 'superadmin' &&
          String(u.username || '').toLowerCase() !== 'superadmin'
      ),
    [users]
  );

  const getUserSyncStatus = useCallback(
    (u: any) => {
      const matchedTeacher = findMatchingTeacherForUser(u, teachers);
      const isFaceEnrolled = faceTemplates.some(
        (f) =>
          f.personType === 'teacher' &&
          (f.personId === u.id ||
            (u.teacherId && f.personId === u.teacherId) ||
            (matchedTeacher && f.personId === matchedTeacher.id))
      );
      return { matchedTeacher, isFaceEnrolled };
    },
    [teachers, faceTemplates]
  );

  const ensureTeacherRecordForUser = async (
    userObj: {
      id?: string;
      teacherId?: string;
      name: string;
      nip?: string;
      email?: string;
      role: string;
      subject?: string;
      isActive?: boolean;
    },
    syncedTeacher?: any
  ): Promise<string> => {
    if (syncedTeacher?.id) return syncedTeacher.id;
    const matched = findMatchingTeacherForUser(userObj, teachers);
    if (matched?.id) return matched.id;
    try {
      const tRes = await gasPost<any>('createRecord', {
        entity: 'Teachers',
        data: {
          nip: (userObj.nip || '').trim(),
          name: userObj.name.trim(),
          email: (userObj.email || '').trim(),
          phone: '',
          subject: (userObj.subject || '').trim() || defaultSubjectLabelForRole(userObj.role),
          isActive: userObj.isActive !== false,
        },
      });
      if (tRes?.success && tRes?.data?.id) {
        return tRes.data.id;
      }
    } catch (err) {
      console.warn('Client teacher sync fallback failed:', err);
    }
    return userObj.id || '';
  };

  const openEditUserModal = (target: any) => {
    const matchedTeacher = findMatchingTeacherForUser(target, teachers);
    setUserFeedback(null);
    setEditingUser(target);
    setEditForm({
      name: target.name || '',
      username: target.username || '',
      email: target.email || '',
      role: (target.role || 'guru') as any,
      classId: target.classId || '',
      nip: target.nip || matchedTeacher?.nip || '',
      subject: target.subject || matchedTeacher?.subject || '',
      password: '',
      isActive: target.isActive !== false,
    });
  };

  const submitCreateUser = async (goToFaceAfter: boolean) => {
    if (isSavingUser) return;
    setUserFeedback(null);
    if (username.trim().toLowerCase() === 'superadmin') {
      setUserFeedback({ type: 'error', text: 'Admin tidak dapat membuat atau mengatur akun Superadmin.' });
      return;
    }
    setIsSavingUser(true);
    try {
      const effectiveSubject = subject.trim() || defaultSubjectLabelForRole(role);
      const res = await gasPost<any>('createRecord', {
        entity: 'Users',
        data: {
          username: username.trim(),
          password,
          name: name.trim(),
          role,
          classId: role === 'wali_kelas' ? classId : '',
          email: email.trim(),
          nip: nip.trim(),
          subject: effectiveSubject,
        },
      });
      if (res.success) {
        const createdUser = res.data || {};
        const syncedTeacherId = await ensureTeacherRecordForUser(
          {
            id: createdUser.id,
            teacherId: createdUser.teacherId,
            name: name.trim(),
            nip: nip.trim(),
            email: email.trim(),
            role,
            subject: effectiveSubject,
            isActive: true,
          },
          res.syncedTeacher
        );
        await onRefresh();
        const createdName = name.trim();
        setShowModal(false);
        setUsername('');
        setPassword('');
        setName('');
        setEmail('');
        setNip('');
        setSubject('');
        setClassId('');
        const msg = `Akun "${createdName}" berhasil ditambahkan & langsung tersinkron ke Database Wajah.`;
        setUserFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
        if (goToFaceAfter && syncedTeacherId && onJumpToFaceEnroll) {
          onJumpToFaceEnroll({ personType: 'teacher', personId: syncedTeacherId });
        }
      } else {
        const errMsg = res.error || 'Gagal membuat pengguna';
        setUserFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e.message || 'Gagal membuat pengguna';
      setUserFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitCreateUser(false);
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser || isSavingUser) return;
    setUserFeedback(null);
    const trimmedUsername = editForm.username.trim();
    const trimmedName = editForm.name.trim();
    if (!trimmedName || !trimmedUsername) {
      setUserFeedback({ type: 'error', text: 'Nama lengkap dan username wajib diisi.' });
      return;
    }
    if (trimmedUsername.toLowerCase() === 'superadmin') {
      setUserFeedback({ type: 'error', text: 'Username "superadmin" dicadangkan untuk akun Superadmin.' });
      return;
    }
    if (editForm.password && editForm.password.length < 5) {
      setUserFeedback({ type: 'error', text: 'Kata sandi baru minimal 5 karakter (atau kosongkan jika tidak diubah).' });
      return;
    }
    setIsSavingUser(true);
    try {
      const effectiveSubject = editForm.subject.trim() || defaultSubjectLabelForRole(editForm.role);
      const updatePayload: Record<string, any> = {
        name: trimmedName,
        username: trimmedUsername,
        email: editForm.email.trim(),
        role: editForm.role,
        classId: editForm.role === 'wali_kelas' ? editForm.classId : '',
        nip: editForm.nip.trim(),
        subject: effectiveSubject,
        isActive: editForm.isActive,
      };
      if (editForm.password.trim()) {
        updatePayload.password = editForm.password.trim();
      }
      const res = await gasPost<any>('updateRecord', {
        entity: 'Users',
        id: editingUser.id,
        data: updatePayload,
        expectedUpdatedAt: editingUser.diubah_pada || editingUser.updatedAt,
      });
      if (res.success) {
        // Fallback sinkronisasi Teachers apabila Apps Script versi lama belum mengembalikan syncedTeacher
        if (!('syncedTeacher' in res)) {
          const matchedTeacher = findMatchingTeacherForUser(editingUser, teachers);
          if (matchedTeacher) {
            await gasPost('updateRecord', {
              entity: 'Teachers',
              id: matchedTeacher.id,
              data: {
                name: trimmedName,
                nip: editForm.nip.trim(),
                email: editForm.email.trim(),
                subject: effectiveSubject,
                isActive: editForm.isActive,
              },
              expectedUpdatedAt: matchedTeacher.diubah_pada || matchedTeacher.updatedAt,
            }).catch(() => {});
          } else if (editForm.isActive) {
            await ensureTeacherRecordForUser({
              id: editingUser.id,
              name: trimmedName,
              nip: editForm.nip.trim(),
              email: editForm.email.trim(),
              role: editForm.role,
              subject: effectiveSubject,
              isActive: editForm.isActive,
            });
          }
        }
        await onRefresh();
        setEditingUser(null);
        const msg = `Perubahan akun "${trimmedName}" (${trimmedUsername}) tersimpan & tersinkron ke Database Wajah.`;
        setUserFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menyimpan perubahan akun.';
        setUserFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e?.message || 'Gagal menyimpan perubahan akun.';
      setUserFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleDirectFaceEnroll = async (targetUser: any) => {
    if (!onJumpToFaceEnroll || ensuringFaceUserId) return;
    setEnsuringFaceUserId(targetUser.id);
    try {
      const teacherId = await ensureTeacherRecordForUser(targetUser);
      await onRefresh();
      onJumpToFaceEnroll({ personType: 'teacher', personId: teacherId || targetUser.id });
    } finally {
      setEnsuringFaceUserId(null);
    }
  };

  const handleToggleActive = async (targetUser: any) => {
    setUserFeedback(null);
    if (String(targetUser.role || '').toLowerCase() === 'superadmin') {
      setUserFeedback({ type: 'error', text: 'Akun Superadmin tidak dapat diubah oleh Admin.' });
      return;
    }
    setTogglingUserId(targetUser.id);
    try {
      const nextActive = !targetUser.isActive;
      const res = await gasPost('updateRecord', {
        entity: 'Users',
        id: targetUser.id,
        data: { isActive: nextActive },
        expectedUpdatedAt: targetUser.diubah_pada || targetUser.updatedAt,
      });
      if (res.success) {
        await onRefresh();
        const msg = `Status akun "${targetUser.name}" diubah menjadi ${nextActive ? 'Aktif' : 'Nonaktif'}.`;
        setUserFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal memperbarui status pengguna.';
        setUserFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e.message || 'Gagal memperbarui status pengguna.';
      setUserFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setTogglingUserId(null);
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!deleteUserTarget) return;
    setUserFeedback(null);
    if (String(deleteUserTarget.role || '').toLowerCase() === 'superadmin') {
      setUserFeedback({ type: 'error', text: 'Akun Superadmin tidak dapat dihapus oleh Admin.' });
      setDeleteUserTarget(null);
      return;
    }
    setIsDeletingUser(true);
    try {
      const res = await gasPost('softDeleteRecord', {
        entity: 'Users',
        id: deleteUserTarget.id,
        expectedUpdatedAt: deleteUserTarget.diubah_pada || deleteUserTarget.updatedAt,
      });
      if (res.success) {
        await onRefresh();
        const deletedName = deleteUserTarget.name;
        setDeleteUserTarget(null);
        const msg = `Akun "${deletedName}" berhasil dihapus bersih dari Sheets.`;
        setUserFeedback({ type: 'success', text: msg });
        onDeletedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menghapus pengguna.';
        setUserFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e.message || 'Gagal menghapus pengguna.';
      setUserFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsDeletingUser(false);
    }
  };

  const handleConfirmResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget || resetNewPassword.length < 5) {
      setUserFeedback({ type: 'error', text: 'Password baru minimal 5 karakter.' });
      return;
    }
    if (isResettingPassword) return;
    setIsResettingPassword(true);
    try {
      const res = await gasPost('resetUserPassword', {
        id: resetTarget.id,
        newPassword: resetNewPassword,
        expectedUpdatedAt: resetTarget.diubah_pada,
      });
      if (res.success) {
        await onRefresh();
        const targetName = resetTarget.name;
        setResetTarget(null);
        setResetNewPassword('');
        const msg = `Kata sandi "${targetName}" berhasil diperbarui & tersimpan.`;
        setUserFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal mereset kata sandi.';
        setUserFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e.message || 'Gagal mereset kata sandi.';
      setUserFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsResettingPassword(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Manajemen Akun Multi-Pengguna</h3>
          <p className="text-xs text-slate-500">
            Atur username login, kata sandi, dan peran untuk Admin, Wali Kelas, Guru BK, Kesiswaan, Kepala Sekolah &amp; Guru. Setiap login menu wajib memasukkan username &amp; sandi yang diatur di sini.
          </p>
        </div>
        <button
          onClick={() => {
            setUserFeedback(null);
            setShowModal(true);
          }}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition"
        >
          <Plus className="w-4 h-4" />
          <span>Tambah Pengguna</span>
        </button>
      </div>

      {userFeedback && (
        <div
          className={`p-3 rounded-2xl text-xs flex items-center gap-2 border font-semibold ${
            userFeedback.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          {userFeedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
          ) : (
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
          )}
          <span>{userFeedback.text}</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
              <th className="py-3 px-3">Nama Lengkap</th>
              <th className="py-3 px-3">Username Login</th>
              <th className="py-3 px-3">Peran (Role)</th>
              <th className="py-3 px-3">Kelas Binaan</th>
              <th className="py-3 px-3">Database Wajah</th>
              <th className="py-3 px-3">Sesi &amp; Status</th>
              <th className="py-3 px-3 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {visibleUsers.map(u => {
              const isOnline = onlineUserIds.has(u.id);
              const isSelf = u.id === currentUserId;
              const isToggling = togglingUserId === u.id;
              const isEnsuringFace = ensuringFaceUserId === u.id;
              const { isFaceEnrolled } = getUserSyncStatus(u);
              return (
                <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="py-3 px-3 font-bold text-slate-900 dark:text-white">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-700'
                        }`}
                        title={isOnline ? 'Sedang Online Real-Time' : 'Offline'}
                      />
                      <span>{u.name}</span>
                      {isSelf && (
                        <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">(Anda)</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-600 dark:text-slate-300 font-semibold">{u.username}</td>
                  <td className="py-3 px-3">
                    <span className="px-2 py-0.5 rounded-md font-semibold text-[10px] bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                      {formatRoleDisplayLabel(u.role)}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-slate-500">
                    {classes.find(c => c.id === u.classId)?.name || '-'}
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold text-[10px] ${
                        isFaceEnrolled
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                      }`}
                    >
                      {isFaceEnrolled ? 'Wajah Terdaftar' : 'Siap Rekam Wajah'}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={isSelf || isToggling}
                        onClick={() => void handleToggleActive(u)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold transition ${
                          u.isActive
                            ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950 hover:bg-emerald-100'
                            : 'text-slate-500 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200'
                        } disabled:opacity-60`}
                        title={isSelf ? 'Akun yang sedang digunakan' : 'Klik untuk ubah status aktif/nonaktif'}
                      >
                        {isToggling && <Loader2 className="w-3 h-3 animate-spin" />}
                        <span>{u.isActive ? 'Aktif' : 'Nonaktif'}</span>
                      </button>
                      {isOnline && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-900/40">
                          Online
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right space-x-1 whitespace-nowrap">
                    {onJumpToFaceEnroll && u.isActive !== false && (
                      <button
                        type="button"
                        disabled={Boolean(ensuringFaceUserId)}
                        onClick={() => void handleDirectFaceEnroll(u)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 dark:hover:bg-emerald-900/60 rounded-lg transition disabled:opacity-50"
                        title="Langsung buka Database Wajah untuk pengguna ini"
                      >
                        {isEnsuringFace ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Camera className="w-3 h-3" />
                        )}
                        <span>{isFaceEnrolled ? 'Update Wajah' : 'Rekam Wajah'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEditUserModal(u)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950 rounded-lg transition"
                      title="Edit Username, Nama, Peran & Kata Sandi"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setResetTarget({ id: u.id, name: u.name, diubah_pada: u.diubah_pada || u.updatedAt });
                        setResetNewPassword('');
                      }}
                      className="px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-lg transition"
                    >
                      Reset Sandi
                    </button>
                    {!isSelf && (
                      <button
                        type="button"
                        onClick={() => setDeleteUserTarget(u)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition align-middle"
                        title="Hapus akun pengguna"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        isOpen={Boolean(deleteUserTarget)}
        title="Hapus Akun Pengguna"
        message={`Hapus akun "${deleteUserTarget?.name || ''}" (username: ${deleteUserTarget?.username || '-'})?`}
        confirmLabel="Ya, Hapus"
        isLoading={isDeletingUser}
        onCancel={() => setDeleteUserTarget(null)}
        onConfirm={handleConfirmDeleteUser}
      />

      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-1">
              Edit Akun: {editingUser.name}
            </h3>
            <p className="text-[11px] text-slate-500 mb-4">
              Perubahan username &amp; sandi langsung berlaku saat pengguna login ke menu yang dilindungi kata sandi.
            </p>
            <form onSubmit={handleUpdateUser} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Nama Lengkap</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Username / Login (Wajib saat Login)</label>
                <input
                  type="text"
                  value={editForm.username}
                  onChange={e => setEditForm({ ...editForm, username: e.target.value })}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-mono"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Email (Opsional)</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                  placeholder="nama@sekolah.sch.id"
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Peran (Role)</label>
                <select
                  value={editForm.role}
                  onChange={e => setEditForm({ ...editForm, role: e.target.value as any })}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                >
                  <option value="guru">Guru Mapel</option>
                  <option value="wali_kelas">Wali Kelas</option>
                  <option value="bk">Guru BK</option>
                  <option value="kesiswaan">Staf Kesiswaan</option>
                  <option value="kepala_sekolah">Kepala Sekolah</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">NIP (Opsional)</label>
                  <input
                    type="text"
                    value={editForm.nip}
                    onChange={e => setEditForm({ ...editForm, nip: e.target.value })}
                    placeholder="1990..."
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Jabatan / Mata Pelajaran</label>
                  <input
                    type="text"
                    value={editForm.subject}
                    onChange={e => setEditForm({ ...editForm, subject: e.target.value })}
                    placeholder="Kepala Sekolah / Guru Mapel"
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
              </div>
              {editForm.role === 'wali_kelas' && (
                <div>
                  <label className="block font-semibold mb-1">Kelas yang Diampu</label>
                  <select
                    value={editForm.classId}
                    onChange={e => setEditForm({ ...editForm, classId: e.target.value })}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="">-- Pilih Kelas --</option>
                    {classes.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block font-semibold mb-1">Kata Sandi Baru (Kosongkan jika tidak diubah)</label>
                <PasswordInput
                  value={editForm.password}
                  onChange={e => setEditForm({ ...editForm, password: e.target.value })}
                  placeholder="Minimal 5 karakter jika ingin ganti sandi"
                  className="text-xs py-2.5"
                />
              </div>
              {editingUser.id !== currentUserId && (
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={editForm.isActive}
                    onChange={e => setEditForm({ ...editForm, isActive: e.target.checked })}
                    className="rounded text-blue-600 w-4 h-4"
                  />
                  <span className="font-semibold">Akun Aktif (Bisa Login)</span>
                </label>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isSavingUser}
                  onClick={() => setEditingUser(null)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSavingUser}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                >
                  {isSavingUser ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Simpan Perubahan</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4">
          <div className="w-full max-w-sm max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">
              Reset Kata Sandi: {resetTarget.name}
            </h4>
            <form onSubmit={handleConfirmResetPassword} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Kata Sandi Baru (Minimal 5 karakter)</label>
                <PasswordInput
                  value={resetNewPassword}
                  onChange={e => setResetNewPassword(e.target.value)}
                  placeholder="Masukkan kata sandi baru"
                  className="text-xs py-2.5"
                  minLength={5}
                  required
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={isResettingPassword}
                  onClick={() => setResetTarget(null)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isResettingPassword}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                >
                  {isResettingPassword ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Simpan Sandi</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-1">Tambah Pengguna Baru</h3>
            <p className="text-[11px] text-slate-500 mb-4">
              Semua pengguna aktif (Guru, Kepala Sekolah, Wali Kelas, BK, Kesiswaan &amp; Admin) otomatis sinkron ke Database Wajah.
            </p>
            <form ref={createFormRef} onSubmit={handleCreate} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Nama Lengkap</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Username / Login</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-mono"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Email (Opsional)</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="nama@sekolah.sch.id"
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Password</label>
                <PasswordInput
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Minimal 5 karakter"
                  className="text-xs py-2.5"
                  minLength={5}
                  required
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">Peran (Role)</label>
                <select
                  value={role}
                  onChange={e => setRole(e.target.value as any)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                >
                  <option value="guru">Guru Mapel</option>
                  <option value="wali_kelas">Wali Kelas</option>
                  <option value="bk">Guru BK</option>
                  <option value="kesiswaan">Staf Kesiswaan</option>
                  <option value="kepala_sekolah">Kepala Sekolah</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">NIP (Opsional)</label>
                  <input
                    type="text"
                    value={nip}
                    onChange={e => setNip(e.target.value)}
                    placeholder="1990..."
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Mata Pelajaran / Jabatan</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                    placeholder={defaultSubjectLabelForRole(role)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
              </div>

              {role === 'wali_kelas' && (
                <div>
                  <label className="block font-semibold mb-1">Kelas yang Diampu</label>
                  <select
                    value={classId}
                    onChange={e => setClassId(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="">-- Pilih Kelas --</option>
                    {classes.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isSavingUser}
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-50"
                >
                  Batal
                </button>
                {onJumpToFaceEnroll && (
                  <button
                    type="button"
                    disabled={isSavingUser}
                    onClick={() => {
                      if (createFormRef.current && !createFormRef.current.reportValidity()) {
                        return;
                      }
                      void submitCreateUser(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                  >
                    {isSavingUser ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Camera className="w-3.5 h-3.5" />
                    )}
                    <span>Simpan &amp; Rekam Wajah</span>
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSavingUser}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                >
                  {isSavingUser ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Simpan</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// Locations Section
const LocationsSection: React.FC<{
  locations: SchoolLocation[];
  onRefresh: () => Promise<void> | void;
  onSavedToast?: (msg: string) => void;
  onDeletedToast?: (msg: string) => void;
  onErrorToast?: (msg: string) => void;
}> = ({ locations, onRefresh, onSavedToast, onDeletedToast, onErrorToast }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingLocation, setEditingLocation] = useState<SchoolLocation | null>(null);
  const [name, setName] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radiusMeters, setRadiusMeters] = useState('150');
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SchoolLocation | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const openAddModal = () => {
    setFeedback(null);
    setEditingLocation(null);
    setName('');
    setLatitude('');
    setLongitude('');
    setRadiusMeters('150');
    setShowModal(true);
  };

  const openEditModal = (loc: SchoolLocation) => {
    setFeedback(null);
    setEditingLocation(loc);
    setName(loc.name || '');
    setLatitude(String(loc.latitude ?? ''));
    setLongitude(String(loc.longitude ?? ''));
    setRadiusMeters(String(loc.radiusMeters ?? 150));
    setShowModal(true);
  };

  const handleGetCurrentGps = () => {
    setFeedback(null);
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          setLatitude(String(pos.coords.latitude));
          setLongitude(String(pos.coords.longitude));
        },
        err => setFeedback({ type: 'error', text: 'Gagal mendeteksi GPS: ' + err.message })
      );
    } else {
      setFeedback({ type: 'error', text: 'Browser ini tidak mendukung Geolocation GPS.' });
    }
  };

  const handleSaveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setFeedback(null);
    setIsSaving(true);
    try {
      const payload = {
        name: name.trim(),
        latitude: Number(latitude),
        longitude: Number(longitude),
        radiusMeters: Number(radiusMeters) || 150,
      };
      const res = editingLocation
        ? await gasPost('updateRecord', {
            entity: 'Locations',
            id: editingLocation.id,
            data: payload,
            expectedUpdatedAt: editingLocation.diubah_pada || editingLocation.updatedAt,
          })
        : await gasPost('createRecord', {
            entity: 'Locations',
            data: payload,
          });
      if (res.success) {
        await onRefresh();
        const msg = editingLocation
          ? `Perubahan titik lokasi "${payload.name}" tersimpan.`
          : `Titik lokasi geofence "${payload.name}" berhasil disimpan.`;
        setShowModal(false);
        setEditingLocation(null);
        setName('');
        setLatitude('');
        setLongitude('');
        setFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menyimpan lokasi.';
        setFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e?.message || 'Gagal menyimpan lokasi.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Titik Geofence Presensi Guru</h3>
          <p className="text-xs text-slate-500">Presensi guru hanya diterima jika berada dalam radius titik ini</p>
        </div>
        <button
          onClick={openAddModal}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition"
        >
          <Plus className="w-4 h-4" />
          <span>Tambah Lokasi</span>
        </button>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 ${
            feedback.type === 'error'
              ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
              : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
          }`}
        >
          <span className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{feedback.text}</span>
          </span>
          <button type="button" onClick={() => setFeedback(null)} className="font-bold hover:underline">
            Tutup
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {locations.map(loc => (
          <div
            key={loc.id}
            className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-sm text-slate-900 dark:text-white">{loc.name}</span>
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 font-bold text-[10px]">
                Radius {loc.radiusMeters}m
              </span>
            </div>
            <div className="font-mono text-slate-500 text-[11px]">
              Lat: {loc.latitude}, Lng: {loc.longitude}
            </div>
            <div className="pt-2 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => openEditModal(loc)}
                className="text-blue-600 hover:text-blue-700 text-xs font-semibold flex items-center gap-1"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>Edit</span>
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(loc)}
                className="text-red-500 hover:text-red-700 text-xs flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Hapus</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Hapus Titik Lokasi"
        message={`Hapus titik lokasi "${deleteTarget?.name || ''}"?`}
        confirmLabel="Ya, Hapus"
        isLoading={isDeleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setIsDeleting(true);
          try {
            const res = await gasPost('softDeleteRecord', {
              entity: 'Locations',
              id: deleteTarget.id,
              expectedUpdatedAt: deleteTarget.diubah_pada || deleteTarget.updatedAt,
            });
            if (!res?.success) {
              throw new Error(res?.error || 'Gagal menghapus titik lokasi di server.');
            }
            await onRefresh();
            const deletedName = deleteTarget.name;
            setDeleteTarget(null);
            const msg = `Lokasi ${deletedName} berhasil dihapus dari Sheets.`;
            setFeedback({ type: 'success', text: msg });
            onDeletedToast?.(msg);
          } catch (err: any) {
            const errMsg = err?.message || 'Gagal menghapus lokasi.';
            setFeedback({ type: 'error', text: errMsg });
            setDeleteTarget(null);
            onErrorToast?.(errMsg);
          } finally {
            setIsDeleting(false);
          }
        }}
      />

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4">
              {editingLocation ? `Edit Titik Lokasi: ${editingLocation.name}` : 'Tambah Titik Lokasi Baru'}
            </h3>
            <form onSubmit={handleSaveLocation} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Nama Titik Lokasi</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Contoh: Kampus Utama / Gedung Lab"
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div className="flex gap-2 items-center">
                <button
                  type="button"
                  onClick={handleGetCurrentGps}
                  className="px-3 py-2 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 rounded-xl font-semibold flex items-center gap-1.5"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Ambil GPS Perangkat Ini</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">Latitude</label>
                  <input
                    type="number"
                    step="any"
                    value={latitude}
                    onChange={e => setLatitude(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    required
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Longitude</label>
                  <input
                    type="number"
                    step="any"
                    value={longitude}
                    onChange={e => setLongitude(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">Radius Toleransi (Meter)</label>
                <input
                  type="number"
                  value={radiusMeters}
                  onChange={e => setRadiusMeters(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => {
                    setShowModal(false);
                    setEditingLocation(null);
                  }}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{editingLocation ? 'Simpan Perubahan' : 'Simpan Lokasi'}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// Classes & Promotion Section
const ClassesSection: React.FC<{
  classes: SchoolClass[];
  teachers: Teacher[];
  students: Student[];
  onRefresh: () => Promise<void> | void;
  onSavedToast?: (msg: string) => void;
  onDeletedToast?: (msg: string) => void;
  onErrorToast?: (msg: string) => void;
}> = ({ classes, teachers, students, onRefresh, onSavedToast, onDeletedToast, onErrorToast }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingClass, setEditingClass] = useState<SchoolClass | null>(null);
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [className, setClassName] = useState('');
  const [grade, setGrade] = useState('10');
  const [level, setLevel] = useState<EducationLevel>('SMK');
  const [homeRoomTeacherId, setHomeRoomTeacherId] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isPromoting, setIsPromoting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SchoolClass | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Promote states
  const [sourceClassId, setSourceClassId] = useState(classes[0]?.id || '');
  const [targetClassId, setTargetClassId] = useState('');
  const [action, setAction] = useState<'promote' | 'graduate'>('promote');

  useEffect(() => {
    if (!sourceClassId && classes.length > 0) {
      setSourceClassId(classes[0].id);
    }
  }, [classes, sourceClassId]);

  const openAddModal = () => {
    setFeedback(null);
    setEditingClass(null);
    setClassName('');
    setGrade('10');
    setLevel('SMK');
    setHomeRoomTeacherId('');
    setShowModal(true);
  };

  const openEditModal = (cls: SchoolClass) => {
    setFeedback(null);
    setEditingClass(cls);
    setClassName(cls.name || '');
    const gStr = String(cls.grade || '10');
    setGrade(gStr);
    setLevel(inferEducationLevel(cls.level, gStr, cls.name));
    setHomeRoomTeacherId(cls.homeRoomTeacherId || '');
    setShowModal(true);
  };

  const handleSaveClass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setFeedback(null);
    setIsSaving(true);
    try {
      const payload = {
        name: className.trim(),
        grade,
        level,
        homeRoomTeacherId,
      };
      const res = editingClass
        ? await gasPost('updateRecord', {
            entity: 'Classes',
            id: editingClass.id,
            data: payload,
            expectedUpdatedAt: editingClass.diubah_pada || editingClass.updatedAt,
          })
        : await gasPost('createRecord', {
            entity: 'Classes',
            data: payload,
          });
      if (res.success) {
        await onRefresh();
        const msg = editingClass
          ? `Perubahan kelas "${payload.name}" tersimpan.`
          : `Kelas baru "${payload.name}" berhasil disimpan.`;
        setShowModal(false);
        setEditingClass(null);
        setClassName('');
        setHomeRoomTeacherId('');
        setFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menyimpan kelas.';
        setFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e?.message || 'Gagal menyimpan kelas.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePromote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPromoting) return;
    setFeedback(null);
    setIsPromoting(true);
    try {
      const res = await gasPost('promoteClass', {
        sourceClassId,
        targetClassId,
        promoteAction: action,
      });
      if (res.success) {
        await onRefresh();
        const msg = res.message || 'Kenaikan kelas berhasil diproses & tersimpan.';
        setFeedback({ type: 'success', text: msg });
        setShowPromoteModal(false);
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal memproses kenaikan kelas.';
        setFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e?.message || 'Gagal memproses kenaikan kelas.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsPromoting(false);
    }
  };

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Manajemen Kelas &amp; Promosi</h3>
          <p className="text-xs text-slate-500">Kelola kelas, penetapan wali kelas, dan kenaikan kelas massal</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setFeedback(null);
              setShowPromoteModal(true);
            }}
            className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-950 dark:text-purple-300 transition"
          >
            Naik Kelas Massal
          </button>
          <button
            onClick={openAddModal}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Kelas</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 ${
            feedback.type === 'error'
              ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
              : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
          }`}
        >
          <span className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{feedback.text}</span>
          </span>
          <button type="button" onClick={() => setFeedback(null)} className="font-bold hover:underline">
            Tutup
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {classes.map(c => {
          const clsLevel = inferEducationLevel(c.level, c.grade, c.name);
          return (
            <div
              key={c.id}
              className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-black text-sm text-slate-900 dark:text-white">{c.name}</span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 font-bold text-[10px]">
                    {clsLevel}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-bold text-[10px]">
                    Tingkat {c.grade}
                  </span>
                </div>
              </div>
            <div className="text-slate-500 text-[11px]">
              Wali: {c.homeRoomTeacherName || 'Belum ada'}
            </div>
            <div className="text-slate-500 text-[11px]">
              Jumlah: {students.filter(s => s.classId === c.id && s.isActive).length} Siswa
            </div>
            <div className="pt-2 flex justify-end gap-3 border-t border-slate-200/70 dark:border-slate-700/70">
              <button
                type="button"
                onClick={() => openEditModal(c)}
                className="text-blue-600 hover:text-blue-700 text-xs font-semibold flex items-center gap-1"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>Edit</span>
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(c)}
                className="text-red-500 hover:text-red-700 text-xs flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Hapus</span>
              </button>
            </div>
            </div>
          );
        })}
      </div>

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Hapus Data Kelas"
        message={`Hapus kelas "${deleteTarget?.name || ''}"?`}
        confirmLabel="Ya, Hapus"
        isLoading={isDeleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setIsDeleting(true);
          try {
            const res = await gasPost('softDeleteRecord', {
              entity: 'Classes',
              id: deleteTarget.id,
              expectedUpdatedAt: deleteTarget.diubah_pada || deleteTarget.updatedAt,
            });
            if (!res?.success) {
              throw new Error(res?.error || 'Gagal menghapus kelas di server.');
            }
            await onRefresh();
            const deletedName = deleteTarget.name;
            setDeleteTarget(null);
            const msg = `Kelas "${deletedName}" berhasil dihapus bersih dari Sheets.`;
            setFeedback({ type: 'success', text: msg });
            onDeletedToast?.(msg);
          } catch (err: any) {
            const errMsg = err?.message || 'Gagal menghapus kelas.';
            setFeedback({ type: 'error', text: errMsg });
            setDeleteTarget(null);
            onErrorToast?.(errMsg);
          } finally {
            setIsDeleting(false);
          }
        }}
      />

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4">
              {editingClass ? `Edit Kelas: ${editingClass.name}` : 'Tambah Kelas Baru'}
            </h3>
            <form onSubmit={handleSaveClass} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Nama Kelas</label>
                <input
                  type="text"
                  value={className}
                  onChange={e => setClassName(e.target.value)}
                  placeholder="Contoh: X RPL 3"
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">Tingkat</label>
                  <select
                    value={grade}
                    onChange={e => {
                      const nextG = e.target.value;
                      setGrade(nextG);
                      setLevel(inferEducationLevel('', nextG, className));
                    }}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="1">Kelas 1 (SD/MI)</option>
                    <option value="2">Kelas 2 (SD/MI)</option>
                    <option value="3">Kelas 3 (SD/MI)</option>
                    <option value="4">Kelas 4 (SD/MI)</option>
                    <option value="5">Kelas 5 (SD/MI)</option>
                    <option value="6">Kelas 6 (SD/MI)</option>
                    <option value="7">Kelas 7 (SMP/MTS)</option>
                    <option value="8">Kelas 8 (SMP/MTS)</option>
                    <option value="9">Kelas 9 (SMP/MTS)</option>
                    <option value="10">Kelas 10 (SMK)</option>
                    <option value="11">Kelas 11 (SMK)</option>
                    <option value="12">Kelas 12 (SMK)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold mb-1">Jenjang</label>
                  <select
                    value={level}
                    onChange={e => setLevel(e.target.value as EducationLevel)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="SD/MI">SD/MI</option>
                    <option value="SMP/MTS">SMP/MTS</option>
                    <option value="SMK">SMK</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">Wali Kelas</label>
                <select
                  value={homeRoomTeacherId}
                  onChange={e => setHomeRoomTeacherId(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                >
                  <option value="">-- Belum Ditentukan --</option>
                  {teachers.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => {
                    setShowModal(false);
                    setEditingClass(null);
                  }}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{editingClass ? 'Simpan Perubahan' : 'Simpan Kelas'}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPromoteModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-2">Kenaikan Kelas Massal</h3>
            <p className="text-xs text-slate-500 mb-4">
              Pindahkan seluruh siswa dari satu kelas ke kelas tingkat selanjutnya atau luluskan.
            </p>

            <form onSubmit={handlePromote} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Kelas Asal</label>
                <select
                  value={sourceClassId}
                  onChange={e => setSourceClassId(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                >
                  {classes.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({students.filter(s => s.classId === c.id && s.isActive).length} Siswa)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold mb-1">Aksi</label>
                <select
                  value={action}
                  onChange={e => setAction(e.target.value as any)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                >
                  <option value="promote">Naik ke Kelas Baru</option>
                  <option value="graduate">Lulus / Alumni (Nonaktifkan)</option>
                </select>
              </div>

              {action === 'promote' && (
                <div>
                  <label className="block font-semibold mb-1">Kelas Tujuan</label>
                  <select
                    value={targetClassId}
                    onChange={e => setTargetClassId(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    required
                  >
                    <option value="">-- Pilih Kelas Tujuan --</option>
                    {classes.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isPromoting}
                  onClick={() => setShowPromoteModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isPromoting}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                >
                  {isPromoting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Memproses...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Proses Kenaikan</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// Date helpers for student birthDate <-> HTML <input type="date">
function normalizeBirthDateToHtmlInput(raw?: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const dmyMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }
  const months: Record<string, string> = {
    januari: '01', jan: '01',
    februari: '02', feb: '02', pebruari: '02',
    maret: '03', mar: '03',
    april: '04', apr: '04',
    mei: '05', may: '05',
    juni: '06', jun: '06',
    juli: '07', jul: '07',
    agustus: '08', agu: '08', agt: '08', aug: '08',
    september: '09', sep: '09', sept: '09',
    oktober: '10', okt: '10', oct: '10',
    november: '11', nov: '11', nopember: '11',
    desember: '12', des: '12', dec: '12',
  };
  const txtMatch = s.toLowerCase().match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (txtMatch && months[txtMatch[2]]) {
    return `${txtMatch[3]}-${months[txtMatch[2]]}-${txtMatch[1].padStart(2, '0')}`;
  }
  return '';
}

function formatBirthDateToDisplay(raw?: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[3].padStart(2, '0')}-${isoMatch[2].padStart(2, '0')}-${isoMatch[1]}`;
  }
  return s;
}

// Students Section
const StudentsSection: React.FC<{
  students: Student[];
  classes: SchoolClass[];
  onRefresh: () => Promise<void> | void;
  onSavedToast?: (msg: string) => void;
  onDeletedToast?: (msg: string) => void;
  onErrorToast?: (msg: string) => void;
}> = ({ students, classes, onRefresh, onSavedToast, onDeletedToast, onErrorToast }) => {
  const [search, setSearch] = useState('');
  const [filterLevel, setFilterLevel] = useState<'ALL' | EducationLevel>('ALL');
  const [showModal, setShowModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [name, setName] = useState('');
  const [nis, setNis] = useState('');
  const [nisn, setNisn] = useState('');
  const [gender, setGender] = useState<'L' | 'P'>('L');
  const [classId, setClassId] = useState(classes[0]?.id || '');
  const [customClassName, setCustomClassName] = useState('');
  const [useCustomClassInput, setUseCustomClassInput] = useState(classes.length === 0);
  const [level, setLevel] = useState<EducationLevel>('SMK');
  const [levelManuallySelected, setLevelManuallySelected] = useState(false);
  const [birthPlace, setBirthPlace] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [address, setAddress] = useState('');
  const [barcodeCard, setBarcodeCard] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Student | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Inline quick class edit per row
  const [inlineClassStudentId, setInlineClassStudentId] = useState<string | null>(null);
  const [inlineClassName, setInlineClassName] = useState('');
  const [isSavingInlineClass, setIsSavingInlineClass] = useState(false);

  useEffect(() => {
    if (!classId && !useCustomClassInput && classes.length > 0 && !showModal) {
      setClassId(classes[0].id);
    }
  }, [classes, classId, useCustomClassInput, showModal]);

  const resolveStudentLevel = (st: Student): EducationLevel => {
    const cls = classes.find(c => c.id === st.classId);
    return inferEducationLevel(st.level || cls?.level, cls?.grade, cls?.name);
  };

  const findMatchingClassByName = (rawName: string, preferredLevel?: EducationLevel): SchoolClass | undefined => {
    const key = rawName.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key) return undefined;
    if (preferredLevel) {
      const exactLvl = classes.find(
        c => c.name.trim().toLowerCase().replace(/\s+/g, ' ') === key &&
             inferEducationLevel(c.level, c.grade, c.name) === preferredLevel
      );
      if (exactLvl) return exactLvl;
    }
    return classes.find(c => c.name.trim().toLowerCase().replace(/\s+/g, ' ') === key);
  };

  const matchedCustomClass = useMemo(() => {
    if (!useCustomClassInput || !customClassName.trim()) return undefined;
    return findMatchingClassByName(customClassName, level);
  }, [useCustomClassInput, customClassName, level, classes]);

  const openAddModal = () => {
    const firstCls = classes[0];
    setFeedback(null);
    setEditingStudent(null);
    setName('');
    setNis('');
    setNisn('');
    setGender('L');
    setClassId(firstCls?.id || '');
    setCustomClassName('');
    setUseCustomClassInput(classes.length === 0);
    setLevel(inferEducationLevel(firstCls?.level, firstCls?.grade, firstCls?.name));
    setLevelManuallySelected(false);
    setBirthPlace('');
    setBirthDate('');
    setAddress('');
    setBarcodeCard('');
    setParentPhone('');
    setShowModal(true);
  };

  const openEditModal = (st: Student) => {
    const matchedCls = classes.find(c => c.id === st.classId);
    setFeedback(null);
    setEditingStudent(st);
    setName(st.name || '');
    setNis(st.nis || '');
    setNisn(st.nisn || '');
    setGender((st.gender || 'L') as 'L' | 'P');
    setClassId(matchedCls ? matchedCls.id : '');
    setCustomClassName('');
    setUseCustomClassInput(classes.length === 0);
    setLevel(resolveStudentLevel(st));
    setLevelManuallySelected(false);
    setBirthPlace(st.birthPlace || '');
    setBirthDate(normalizeBirthDateToHtmlInput(st.birthDate));
    setAddress(st.address || '');
    setBarcodeCard(st.barcodeCard || '');
    setParentPhone(st.parentPhone || '');
    setShowModal(true);
  };

  const handleSaveInlineClass = async (st: Student) => {
    if (isSavingInlineClass) return;
    const trimmedTarget = inlineClassName.trim();
    if (!trimmedTarget) {
      onErrorToast?.('Nama kelas tidak boleh kosong.');
      return;
    }

    const hintLevel = detectExplicitLevelFromClassName(trimmedTarget);
    const existingMatch = findMatchingClassByName(trimmedTarget, hintLevel || resolveStudentLevel(st));
    if (existingMatch && existingMatch.id === st.classId) {
      setInlineClassStudentId(null);
      setInlineClassName('');
      return;
    }

    setIsSavingInlineClass(true);
    setFeedback(null);
    try {
      const nextLevel: EducationLevel = existingMatch
        ? inferEducationLevel(existingMatch.level, existingMatch.grade, existingMatch.name)
        : (hintLevel || resolveStudentLevel(st));

      const updatePayload: Record<string, any> = existingMatch
        ? { classId: existingMatch.id, level: nextLevel }
        : { classId: '', className: trimmedTarget, level: nextLevel };

      const res = await gasPost('updateRecord', {
        entity: 'Students',
        id: st.id,
        data: updatePayload,
        expectedUpdatedAt: st.diubah_pada || st.updatedAt,
      });

      if (!res?.success) {
        throw new Error(res?.error || 'Gagal menyimpan kelas siswa.');
      }

      await onRefresh();
      setInlineClassStudentId(null);
      setInlineClassName('');

      const createdClsName = res?.autoCreatedClass?.name;
      const msg = createdClsName
        ? `Siswa "${st.name}" ditempatkan ke kelas "${createdClsName}" & kelas baru otomatis ditambahkan ke Data Kelas.`
        : `Kelas siswa "${st.name}" diperbarui menjadi "${existingMatch?.name || trimmedTarget}".`;
      setFeedback({ type: 'success', text: msg });
      onSavedToast?.(msg);
    } catch (err: any) {
      const errMsg = err?.message || 'Gagal memperbarui kelas siswa.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsSavingInlineClass(false);
    }
  };

  const handleSaveStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setFeedback(null);

    const trimmedCustomClass = customClassName.trim();
    if (useCustomClassInput && !trimmedCustomClass) {
      const errMsg = 'Silakan ketik nama kelas baru atau pilih dari daftar kelas.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
      return;
    }

    setIsSaving(true);
    try {
      const trimmedNis = nis.trim();
      const trimmedNisn = nisn.trim();
      const formattedBirthDate = formatBirthDateToDisplay(birthDate);

      let resolvedClassIdPayload = classId;
      let resolvedClassNamePayload = '';
      let resolvedLevelPayload: EducationLevel = level;

      if (useCustomClassInput && trimmedCustomClass) {
        if (matchedCustomClass) {
          resolvedClassIdPayload = matchedCustomClass.id;
          resolvedLevelPayload = inferEducationLevel(matchedCustomClass.level, matchedCustomClass.grade, matchedCustomClass.name);
        } else {
          resolvedClassIdPayload = '';
          resolvedClassNamePayload = trimmedCustomClass;
        }
      }

      let res: any;
      if (editingStudent) {
        // Send only changed fields for NIS/NISN/barcodeCard so editing TTL/class never disturbs or conflicts with existing NIS/NISN
        const updatePayload: Record<string, any> = {
          name: name.trim(),
          gender,
          classId: resolvedClassIdPayload,
          level: resolvedLevelPayload,
          birthPlace: birthPlace.trim(),
          birthDate: formattedBirthDate,
          address: address.trim(),
          parentPhone: parentPhone.trim(),
        };
        if (resolvedClassNamePayload) {
          updatePayload.className = resolvedClassNamePayload;
        }
        if (trimmedNis !== String(editingStudent.nis || '').trim()) {
          updatePayload.nis = trimmedNis;
        }
        if (trimmedNisn !== String(editingStudent.nisn || '').trim()) {
          updatePayload.nisn = trimmedNisn;
        }
        const nextBarcode = barcodeCard.trim() || `CARD-${trimmedNis}`;
        if (nextBarcode !== String(editingStudent.barcodeCard || '').trim()) {
          updatePayload.barcodeCard = nextBarcode;
        }
        res = await gasPost('updateRecord', {
          entity: 'Students',
          id: editingStudent.id,
          data: updatePayload,
          expectedUpdatedAt: editingStudent.diubah_pada || editingStudent.updatedAt,
        });
      } else {
        const createPayload: Record<string, any> = {
          name: name.trim(),
          nis: trimmedNis,
          nisn: trimmedNisn,
          gender,
          classId: resolvedClassIdPayload,
          level: resolvedLevelPayload,
          birthPlace: birthPlace.trim(),
          birthDate: formattedBirthDate,
          address: address.trim(),
          barcodeCard: barcodeCard.trim() || `CARD-${trimmedNis}`,
          parentPhone: parentPhone.trim(),
        };
        if (resolvedClassNamePayload) {
          createPayload.className = resolvedClassNamePayload;
        }
        res = await gasPost('createRecord', {
          entity: 'Students',
          data: createPayload,
        });
      }

      if (res.success) {
        await onRefresh();
        const savedName = name.trim();
        const createdClsName = res?.autoCreatedClass?.name;
        const msg = createdClsName
          ? `${editingStudent ? 'Perubahan data' : 'Data'} siswa "${savedName}" tersimpan & kelas baru "${createdClsName}" otomatis ditambahkan ke Data Kelas.`
          : editingStudent
            ? `Perubahan data siswa "${savedName}" (${resolvedLevelPayload}) tersimpan & tersinkron ke kartu siswa.`
            : `Data siswa baru "${savedName}" (${resolvedLevelPayload}) berhasil ditambahkan.`;
        setShowModal(false);
        setEditingStudent(null);
        setName('');
        setNis('');
        setNisn('');
        setCustomClassName('');
        setUseCustomClassInput(false);
        setBirthPlace('');
        setBirthDate('');
        setAddress('');
        setBarcodeCard('');
        setParentPhone('');
        setFeedback({ type: 'success', text: msg });
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Gagal menyimpan data siswa.';
        setFeedback({ type: 'error', text: errMsg });
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e?.message || 'Gagal menyimpan data siswa.';
      setFeedback({ type: 'error', text: errMsg });
      onErrorToast?.(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  const filtered = students.filter(s => {
    if (filterLevel !== 'ALL' && resolveStudentLevel(s) !== filterLevel) return false;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.nis.includes(search) ||
      (s.nisn || '').includes(search) ||
      (s.birthPlace || '').toLowerCase().includes(q) ||
      (s.address || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Database Siswa ({filtered.length} / {students.length})</h3>
          <p className="text-xs text-slate-500">Kelola &amp; edit data masing-masing siswa, tempat/tanggal lahir (TTL), jenjang, alamat, dan kontak wali (sinkron otomatis ke kartu siswa)</p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <select
            value={filterLevel}
            onChange={e => setFilterLevel(e.target.value as any)}
            className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
          >
            <option value="ALL">Semua Jenjang</option>
            <option value="SD/MI">SD/MI</option>
            <option value="SMP/MTS">SMP/MTS</option>
            <option value="SMK">SMK</option>
          </select>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cari siswa, NIS, atau alamat..."
            className="px-3.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl flex-1 sm:flex-initial"
          />
          <button
            onClick={openAddModal}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Siswa</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 ${
            feedback.type === 'error'
              ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
              : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
          }`}
        >
          <span className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{feedback.text}</span>
          </span>
          <button type="button" onClick={() => setFeedback(null)} className="font-bold hover:underline">
            Tutup
          </button>
        </div>
      )}

      <datalist id="students-inline-class-datalist">
        {classes.map(c => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
              <th className="py-3 px-3">NIS / NISN</th>
              <th className="py-3 px-3">Nama Siswa</th>
              <th className="py-3 px-3">Tempat, Tgl Lahir</th>
              <th className="py-3 px-3">Jenjang</th>
              <th className="py-3 px-3">Kelas</th>
              <th className="py-3 px-3">Alamat</th>
              <th className="py-3 px-3">Kode Barcode/RFID</th>
              <th className="py-3 px-3">Wajah</th>
              <th className="py-3 px-3 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map(s => {
              const stdLevel = resolveStudentLevel(s);
              const ttlDate = formatBirthDateToDisplay(s.birthDate);
              const ttlDisplay =
                s.birthPlace && ttlDate
                  ? `${s.birthPlace}, ${ttlDate}`
                  : s.birthPlace || ttlDate || '-';
              const currentClsObj = classes.find(c => c.id === s.classId);
              const isInlineEditing = inlineClassStudentId === s.id;
              return (
                <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="py-3 px-3 font-mono">
                    <div>{s.nis}</div>
                    {s.nisn && <div className="text-[10px] text-blue-600">{s.nisn}</div>}
                  </td>
                  <td className="py-3 px-3 font-bold text-slate-900 dark:text-white">{s.name}</td>
                  <td className="py-3 px-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{ttlDisplay}</td>
                  <td className="py-3 px-3">
                    <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 font-bold text-[10px]">
                      {stdLevel}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    {isInlineEditing ? (
                      <div className="flex flex-col gap-1 min-w-[165px]">
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            list="students-inline-class-datalist"
                            value={inlineClassName}
                            onChange={e => setInlineClassName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleSaveInlineClass(s);
                              } else if (e.key === 'Escape') {
                                setInlineClassStudentId(null);
                                setInlineClassName('');
                              }
                            }}
                            placeholder="Ketik / pilih kelas..."
                            autoFocus
                            className="w-28 px-2 py-1 text-[11px] bg-white dark:bg-slate-800 border border-blue-400 rounded-lg outline-none"
                          />
                          <button
                            type="button"
                            disabled={isSavingInlineClass}
                            onClick={() => void handleSaveInlineClass(s)}
                            className="p-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                            title="Simpan kelas"
                          >
                            {isSavingInlineClass ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            type="button"
                            disabled={isSavingInlineClass}
                            onClick={() => {
                              setInlineClassStudentId(null);
                              setInlineClassName('');
                            }}
                            className="p-1 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-200 disabled:opacity-50"
                            title="Batal"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {inlineClassName.trim() && !findMatchingClassByName(inlineClassName, detectExplicitLevelFromClassName(inlineClassName) || stdLevel) && (
                          <span className="text-[10px] text-blue-600 dark:text-blue-400 font-medium">
                            + Kelas baru otomatis masuk Data Kelas
                          </span>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setInlineClassStudentId(s.id);
                          setInlineClassName(currentClsObj?.name || '');
                        }}
                        title="Klik untuk tentukan atau ubah kelas siswa"
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold transition cursor-pointer ${
                          currentClsObj
                            ? 'bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-blue-950/50'
                            : 'bg-amber-50 hover:bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                        }`}
                      >
                        <span>{currentClsObj?.name || '+ Tentukan Kelas'}</span>
                        <Pencil className="w-2.5 h-2.5 opacity-60" />
                      </button>
                    )}
                  </td>
                  <td className="py-3 px-3 text-slate-500 max-w-[180px] truncate" title={s.address || '-'}>
                    {s.address || '-'}
                  </td>
                  <td className="py-3 px-3 font-mono text-[11px] text-blue-600">{s.barcodeCard}</td>
                  <td className="py-3 px-3">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                        s.hasFaceEnrolled
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-slate-100 text-slate-500 dark:bg-slate-800'
                      }`}
                    >
                      {s.hasFaceEnrolled ? 'Terdaftar' : 'Belum'}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-right whitespace-nowrap space-x-1">
                    <button
                      type="button"
                      onClick={() => openEditModal(s)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40 rounded-lg transition"
                      title="Edit data siswa"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(s)}
                      className="p-1 text-slate-400 hover:text-red-600 transition align-middle"
                      title="Hapus siswa"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Hapus Data Siswa"
        message={`Hapus siswa "${deleteTarget?.name || ''}" (NIS: ${deleteTarget?.nis || '-'})?`}
        confirmLabel="Ya, Hapus"
        isLoading={isDeleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setIsDeleting(true);
          try {
            const res = await gasPost('softDeleteRecord', {
              entity: 'Students',
              id: deleteTarget.id,
              expectedUpdatedAt: deleteTarget.diubah_pada || deleteTarget.updatedAt,
            });
            if (!res?.success) {
              throw new Error(res?.error || 'Gagal menghapus siswa di server.');
            }
            await onRefresh();
            const deletedName = deleteTarget.name;
            setDeleteTarget(null);
            const msg = `Siswa ${deletedName} beserta foto/data wajah Drive telah dihapus bersih.`;
            setFeedback({ type: 'success', text: msg });
            onDeletedToast?.(msg);
          } catch (err: any) {
            const errMsg = err?.message || 'Gagal menghapus siswa.';
            setFeedback({ type: 'error', text: errMsg });
            setDeleteTarget(null);
            onErrorToast?.(errMsg);
          } finally {
            setIsDeleting(false);
          }
        }}
      />

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4">
              {editingStudent ? `Edit Siswa: ${editingStudent.name}` : 'Tambah Siswa Baru'}
            </h3>
            <form onSubmit={handleSaveStudent} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Nama Lengkap</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">NIS</label>
                  <input
                    type="text"
                    value={nis}
                    onChange={e => setNis(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    required
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">NISN</label>
                  <input
                    type="text"
                    value={nisn}
                    onChange={e => setNisn(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">Jenis Kelamin</label>
                  <select
                    value={gender}
                    onChange={e => setGender(e.target.value as any)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="L">Laki-laki</option>
                    <option value="P">Perempuan</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Jenjang Pendidikan</label>
                  <select
                    value={level}
                    onChange={e => {
                      setLevel(e.target.value as EducationLevel);
                      setLevelManuallySelected(true);
                    }}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="SD/MI">SD/MI</option>
                    <option value="SMP/MTS">SMP/MTS</option>
                    <option value="SMK">SMK</option>
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-semibold">Kelas</label>
                  {classes.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const nextCustom = !useCustomClassInput;
                        setUseCustomClassInput(nextCustom);
                        if (!nextCustom && !classId && classes[0]) {
                          setClassId(classes[0].id);
                        }
                      }}
                      className="text-[11px] font-semibold text-blue-600 hover:underline cursor-pointer"
                    >
                      {useCustomClassInput ? 'Pilih dari daftar kelas' : '+ Ketik / Buat kelas baru'}
                    </button>
                  )}
                </div>

                {useCustomClassInput ? (
                  <div className="space-y-1.5">
                    <input
                      type="text"
                      list="students-inline-class-datalist"
                      value={customClassName}
                      onChange={e => {
                        const val = e.target.value;
                        setCustomClassName(val);
                        if (!levelManuallySelected) {
                          const hint = detectExplicitLevelFromClassName(val);
                          if (hint) setLevel(hint);
                        }
                      }}
                      placeholder="Ketik nama kelas (misal: X IPA 2, 7B, Kelas 4A)"
                      className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-blue-300 dark:border-blue-700 rounded-xl"
                      required
                    />
                    {customClassName.trim() && (
                      <p className={`text-[11px] font-medium ${matchedCustomClass ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}`}>
                        {matchedCustomClass
                          ? `Kelas "${matchedCustomClass.name}" (${inferEducationLevel(matchedCustomClass.level, matchedCustomClass.grade, matchedCustomClass.name)}) sudah ada — siswa akan dimasukkan ke kelas ini.`
                          : `Kelas baru "${customClassName.trim()}" (${level}) akan otomatis ditambahkan ke Data Kelas saat disimpan.`}
                      </p>
                    )}
                  </div>
                ) : (
                  <select
                    value={classId}
                    onChange={e => {
                      const nextId = e.target.value;
                      if (nextId === '__CUSTOM__') {
                        setUseCustomClassInput(true);
                        setCustomClassName('');
                        return;
                      }
                      setClassId(nextId);
                      const pickedCls = classes.find(c => c.id === nextId);
                      if (pickedCls) {
                        setLevel(inferEducationLevel(pickedCls.level, pickedCls.grade, pickedCls.name));
                        setLevelManuallySelected(false);
                      }
                    }}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    {!classId && <option value="">-- Pilih Kelas --</option>}
                    {classes.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({inferEducationLevel(c.level, c.grade, c.name)})
                      </option>
                    ))}
                    <option value="__CUSTOM__">+ Ketik / Buat Kelas Baru...</option>
                  </select>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">Tempat Lahir</label>
                  <input
                    type="text"
                    value={birthPlace}
                    onChange={e => setBirthPlace(e.target.value)}
                    placeholder="Contoh: Jombang"
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Tanggal Lahir</label>
                  <input
                    type="date"
                    value={birthDate}
                    onChange={e => setBirthDate(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  />
                  {birthDate && (
                    <span className="text-[10px] text-slate-400 mt-0.5 block">
                      Tampil di kartu: {formatBirthDateToDisplay(birthDate)}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">Alamat Lengkap</label>
                <textarea
                  rows={2}
                  value={address}
                  onChange={e => setAddress(e.target.value)}
                  placeholder="Contoh: Jl. Pesantren No. 12, Diwek, Jombang"
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">Kode Kartu Barcode/RFID (Opsional)</label>
                <input
                  type="text"
                  value={barcodeCard}
                  onChange={e => setBarcodeCard(e.target.value)}
                  placeholder="Kosongkan jika otomatis = CARD-[NIS]"
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">No. HP Orang Tua / Wali</label>
                <input
                  type="text"
                  value={parentPhone}
                  onChange={e => setParentPhone(e.target.value)}
                  placeholder="Contoh: 081234567890"
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => {
                    setShowModal(false);
                    setEditingStudent(null);
                  }}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-60 cursor-pointer"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Menyimpan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{editingStudent ? 'Simpan Perubahan' : 'Simpan Siswa'}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// Bulk Upload Section (Excel/CSV Parser & Preview)
const BulkUploadSection: React.FC<{
  classes: SchoolClass[];
  onDownloadTemplate: (preferredLevel?: EducationLevel) => void;
  onRefresh: () => Promise<void> | void;
  onSavedToast?: (msg: string) => void;
  onErrorToast?: (msg: string) => void;
}> = ({ classes, onDownloadTemplate, onRefresh, onSavedToast, onErrorToast }) => {
  const [selectedLevel, setSelectedLevel] = useState<EducationLevel>('SMK');
  const [forceSelectedLevel, setForceSelectedLevel] = useState(false);
  const [selectedClassId, setSelectedClassId] = useState(classes[0]?.id || '');
  const [parsedRows, setParsedRows] = useState<any[]>([]);
  const [errorReport, setErrorReport] = useState<any[]>([]);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const classesForSelectedLevel = classes.filter(
    c => inferEducationLevel(c.level, c.grade, c.name) === selectedLevel
  );

  useEffect(() => {
    const pool = classesForSelectedLevel.length > 0 ? classesForSelectedLevel : classes;
    if (pool.length > 0 && !pool.some(c => c.id === selectedClassId)) {
      setSelectedClassId(pool[0].id);
    }
  }, [classes, selectedLevel]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const buffer = evt.target?.result;
        const wb = XLSX.read(buffer, { type: 'array' });
        const wsname = wb.SheetNames[0];
        if (!wsname) {
          setUploadError('File Excel/CSV kosong atau tidak memiliki sheet.');
          return;
        }
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws);
        setParsedRows(data);
        setErrorReport([]);
        setUploadResult(null);
      } catch (err: any) {
        setUploadError('Gagal membaca file Excel/CSV: ' + (err?.message || 'Format tidak didukung.'));
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const handleExecuteImport = async () => {
    if (parsedRows.length === 0 || isProcessing) return;
    setIsProcessing(true);
    setUploadError(null);
    try {
      const res = await gasPost<{
        importedCount: number;
        createdClassesCount?: number;
        createdClassNames?: string[];
        errorCount: number;
        errorRows: any[];
        message: string;
      }>('bulkImportStudents', {
        rows: parsedRows,
        classId: selectedClassId,
        defaultLevel: selectedLevel,
        forceDefaultLevel: forceSelectedLevel,
      });

      if (res.success) {
        await onRefresh();
        const msg = res.message || `Import ${res.importedCount} data siswa tersimpan ke Google Sheets.`;
        setUploadResult(msg);
        setErrorReport(res.errorRows || []);
        onSavedToast?.(msg);
      } else {
        const errMsg = res.error || 'Import gagal.';
        setUploadError(errMsg);
        onErrorToast?.(errMsg);
      }
    } catch (e: any) {
      const errMsg = e?.message || 'Import gagal.';
      setUploadError(errMsg);
      onErrorToast?.(errMsg);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Upload Massal Data Siswa (Excel/CSV)</h3>
          <p className="text-xs text-slate-500">
            Pilih jenjang terlebih dahulu lalu unduh template sesuai jenjang (berisi kolom jenjang, kelas, dan alamat). Kelas yang belum ada dibuat otomatis &amp; data dipisahkan ke sheet per jenjang.
          </p>
        </div>

        <button
          onClick={() => onDownloadTemplate(selectedLevel)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 transition flex-shrink-0"
        >
          <Download className="w-4 h-4" />
          <span>Unduh Template {selectedLevel} (.xlsx)</span>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
        <div className="space-y-2">
          <label className="block font-bold text-slate-700 dark:text-slate-300">
            1. Pilih Jenjang Upload Massal Terlebih Dahulu
          </label>
          <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
            {(['SD/MI', 'SMP/MTS', 'SMK'] as EducationLevel[]).map(lvl => (
              <button
                key={lvl}
                type="button"
                onClick={() => setSelectedLevel(lvl)}
                className={`py-2 rounded-lg font-bold transition ${
                  selectedLevel === lvl
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[11px] font-medium text-slate-600 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={forceSelectedLevel}
              onChange={e => setForceSelectedLevel(e.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>Terapkan jenjang <strong>{selectedLevel}</strong> ke seluruh baris yang diunggah</span>
          </label>
        </div>

        <div>
          <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1.5">
            2. Kelas Default (Jika kolom kelas pada Excel kosong)
          </label>
          <select
            value={selectedClassId}
            onChange={e => setSelectedClassId(e.target.value)}
            className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
          >
            {(classesForSelectedLevel.length > 0 ? classesForSelectedLevel : classes).map(c => (
              <option key={c.id} value={c.id}>
                {c.name} ({inferEducationLevel(c.level, c.grade, c.name)})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="p-3.5 rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-900 text-[11px] text-blue-800 dark:text-blue-200">
        Kolom <span className="font-mono font-bold">kelas</span> di Excel yang belum terdaftar akan <strong>otomatis dibuat</strong> pada menu Kelas &amp; Naik Kelas, dan siswa otomatis disinkronkan ke sheet <span className="font-mono font-bold">Siswa_SD_MI</span>, <span className="font-mono font-bold">Siswa_SMP_MTS</span>, dan <span className="font-mono font-bold">Siswa_SMK</span>.
      </div>

      <div className="p-6 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 text-center space-y-3 bg-slate-50/50 dark:bg-slate-800/20">
        <Upload className="w-8 h-8 text-blue-500 mx-auto" />
        <div>
          <label className="cursor-pointer font-bold text-xs text-blue-600 hover:text-blue-700">
            <span>Pilih File Excel / CSV</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
          <p className="text-[11px] text-slate-400 mt-1">Mendukung format .xlsx, .xls, .csv</p>
        </div>
      </div>

      {uploadError && (
        <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-200 flex items-center justify-between gap-2 border border-red-200 dark:border-red-900">
          <span>{uploadError}</span>
          <button type="button" onClick={() => setUploadError(null)} className="font-bold hover:underline">
            Tutup
          </button>
        </div>
      )}

      {uploadResult && (
        <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2 border border-emerald-200 font-semibold">
          <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
          <span>{uploadResult}</span>
        </div>
      )}

      {errorReport.length > 0 && (
        <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-200 space-y-1.5 border border-red-200">
          <div className="font-bold">Daftar Baris Error:</div>
          <ul className="list-disc pl-5 space-y-1">
            {errorReport.map((err, i) => (
              <li key={i}>
                Baris #{err.rowNumber}: {err.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {parsedRows.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-900 dark:text-white">
              Pratinjau Data ({parsedRows.length} Baris Terdeteksi)
            </span>

            <button
              onClick={handleExecuteImport}
              disabled={isProcessing}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow disabled:opacity-60 transition cursor-pointer"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Menyimpan ke Database...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Simpan Semua ke Database</span>
                </>
              )}
            </button>
          </div>

          <div className="overflow-x-auto max-h-60 border border-slate-200 dark:border-slate-700 rounded-xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                <tr>
                  <th className="p-2.5">NIS</th>
                  <th className="p-2.5">Nama</th>
                  <th className="p-2.5">Jenjang</th>
                  <th className="p-2.5">Kelas</th>
                  <th className="p-2.5">L/P</th>
                  <th className="p-2.5">Alamat</th>
                  <th className="p-2.5">No HP Ortu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {parsedRows.slice(0, 15).map((r, i) => {
                  const rowCls = r.kelas || r.className || r.class || r.Kelas || '';
                  const rowLvl = forceSelectedLevel
                    ? selectedLevel
                    : inferEducationLevel(r.jenjang || r.level || r.Jenjang || selectedLevel, r.tingkat || r.grade, rowCls);
                  return (
                    <tr key={i}>
                      <td className="p-2.5 font-mono">{r.nis || r.NIS}</td>
                      <td className="p-2.5 font-bold">{r.nama || r.name || r.Nama}</td>
                      <td className="p-2.5">
                        <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 font-bold text-[10px]">
                          {rowLvl}
                        </span>
                      </td>
                      <td className="p-2.5">{rowCls || classes.find(c => c.id === (r.classId || selectedClassId))?.name || '-'}</td>
                      <td className="p-2.5">{r.gender || r.jenisKelamin || 'L'}</td>
                      <td className="p-2.5 max-w-[180px] truncate">{r.alamat || r.address || r.Alamat || '-'}</td>
                      <td className="p-2.5">{r.parentPhone || r.noHpOrtu || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Sub-Component: Rekap Presensi Guru (Harian, Pekan, Bulanan - Sinkron Real-Time)
// ============================================================================
interface TeacherRecapSummaryRow {
  teacherId: string;
  teacherName: string;
  nip: string;
  subject: string;
  email: string;
  tepatWaktu: number;
  terlambat: number;
  izin: number;
  sakit: number;
  totalHadir: number;
  totalRecorded: number;
  belumPresensi: number;
  attendanceRate: number;
  latestDate: string | null;
  latestTimeIn: string | null;
  latestTimeOut: string | null;
  latestStatus: string;
  latestMethod: string | null;
  notes: string | null;
}

interface TeacherRecapRecord {
  id: string;
  teacherId: string;
  teacherName: string;
  nip: string;
  subject: string;
  date: string;
  timeIn: string;
  timeOut?: string;
  status: string;
  method: string;
  sessionId?: string;
  sessionName?: string;
  notes?: string;
}

interface TeacherRecapResponse {
  period: 'daily' | 'weekly' | 'monthly';
  targetDate: string;
  month: string;
  rangeStart: string;
  rangeEnd: string;
  totals: {
    totalTeachers: number;
    totalRecords: number;
    tepatWaktu: number;
    terlambat: number;
    izin: number;
    sakit: number;
    hadirTotal: number;
    belumPresensi: number;
    attendanceRate: number;
  };
  teacherSummaries: TeacherRecapSummaryRow[];
  records: TeacherRecapRecord[];
  dailyBreakdown: Array<{
    date: string;
    tepatWaktu: number;
    terlambat: number;
    izin: number;
    sakit: number;
    total: number;
  }>;
}

function shiftUtcDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().split('T')[0];
}

function shiftYmStr(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return dt.toISOString().slice(0, 7);
}

function formatTanggalIndo(dateStr: string): string {
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

const TeacherRecapSection: React.FC<{
  serverVersion: number;
  teachers: Teacher[];
  sessions: AttendanceSession[];
}> = ({ serverVersion, teachers, sessions }) => {
  const teacherSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.targetType === 'teacher')),
    [sessions]
  );
  const todayStr = getWibTodayStr();
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [selectedMonth, setSelectedMonth] = useState<string>(todayStr.slice(0, 7));
  const [sessionFilter, setSessionFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [recap, setRecap] = useState<TeacherRecapResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string>('');

  // Individual Teacher History Lookup by Date
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>('');
  const [individualDateFilter, setIndividualDateFilter] = useState<string>('');
  const [individualHistory, setIndividualHistory] = useState<TeacherAttendance[]>([]);
  const [loadingIndividual, setLoadingIndividual] = useState<boolean>(false);

  const fetchIndividualTeacherHistory = useCallback(async (teacherIdToLoad: string) => {
    if (!teacherIdToLoad) {
      setIndividualHistory([]);
      return;
    }
    const targetTeacher = teachers.find(t => t.id === teacherIdToLoad);
    setLoadingIndividual(true);
    try {
      const res = await gasGet<TeacherAttendance[]>('teacherHistory', {
        teacherId: teacherIdToLoad,
        userId: teacherIdToLoad,
        userNip: targetTeacher?.nip || '',
        userEmail: targetTeacher?.email || '',
        userName: targetTeacher?.name || '',
        sessionId: sessionFilter !== 'ALL' ? sessionFilter : undefined,
      });
      if (res.success && Array.isArray(res.data)) {
        setIndividualHistory(res.data);
      }
    } catch (err) {
      console.error('Failed to load individual teacher history:', err);
    } finally {
      setLoadingIndividual(false);
    }
  }, [teachers, sessionFilter]);

  useEffect(() => {
    if (selectedTeacherId) {
      void fetchIndividualTeacherHistory(selectedTeacherId);
    }
  }, [selectedTeacherId, serverVersion, fetchIndividualTeacherHistory]);

  const fetchRecap = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await gasGet<TeacherRecapResponse>(
        'teacherRecap',
        period === 'monthly'
          ? { period, month: selectedMonth, sessionId: sessionFilter !== 'ALL' ? sessionFilter : undefined }
          : { period, date: selectedDate, sessionId: sessionFilter !== 'ALL' ? sessionFilter : undefined }
      );
      if (res.success && (res as any).totals) {
        const raw = res as unknown as TeacherRecapResponse & { success: boolean };
        setRecap(raw);
        setLastUpdatedAt(`${formatWibTime24(new Date(), true)} WIB`);
      }
    } catch (err) {
      console.error('Failed to load teacher recap:', err);
    } finally {
      setLoading(false);
    }
  }, [period, selectedDate, selectedMonth, sessionFilter]);

  useEffect(() => {
    fetchRecap(false);
  }, [fetchRecap]);

  // Real-time automatic sync whenever serverVersion updates
  useEffect(() => {
    if (serverVersion === 0) return;
    fetchRecap(true);
  }, [serverVersion, fetchRecap]);

  const handleStepPeriod = (direction: -1 | 1) => {
    if (period === 'daily') {
      setSelectedDate(prev => shiftUtcDateStr(prev, direction));
    } else if (period === 'weekly') {
      setSelectedDate(prev => shiftUtcDateStr(prev, direction * 7));
    } else {
      setSelectedMonth(prev => shiftYmStr(prev, direction));
    }
  };

  const handleResetToday = () => {
    const nowStr = getWibTodayStr();
    setSelectedDate(nowStr);
    setSelectedMonth(nowStr.slice(0, 7));
  };

  const filteredSummaries = (recap?.teacherSummaries || []).filter(item => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      item.teacherName.toLowerCase().includes(q) ||
      item.nip.toLowerCase().includes(q) ||
      item.subject.toLowerCase().includes(q);
    if (!matchesSearch) return false;

    if (statusFilter === 'ALL') return true;
    if (period === 'daily') {
      return item.latestStatus === statusFilter;
    }
    if (statusFilter === 'Tepat Waktu') return item.tepatWaktu > 0;
    if (statusFilter === 'Terlambat') return item.terlambat > 0;
    if (statusFilter === 'Izin') return item.izin > 0;
    if (statusFilter === 'Sakit') return item.sakit > 0;
    if (statusFilter === 'Belum Presensi') return item.totalRecorded === 0;
    return true;
  });

  const filteredRecords = (recap?.records || []).filter(rec => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      rec.teacherName.toLowerCase().includes(q) ||
      rec.nip.toLowerCase().includes(q) ||
      rec.subject.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    if (statusFilter !== 'ALL' && statusFilter !== 'Belum Presensi') {
      return rec.status === statusFilter;
    }
    return true;
  });

  const handleExportExcel = () => {
    if (!recap) return;
    const wb = XLSX.utils.book_new();

    const summaryRows = filteredSummaries.map((s, idx) => ({
      No: idx + 1,
      NIP: s.nip,
      Nama_Guru: s.teacherName,
      Mata_Pelajaran: s.subject,
      ...(period === 'daily'
        ? {
            Tanggal: recap.rangeStart,
            Jam_Masuk: s.latestTimeIn || '-',
            Jam_Pulang: s.latestTimeOut || '-',
            Status: s.latestStatus,
            Metode: s.latestMethod || '-',
            Catatan: s.notes || '-',
          }
        : {
            Tepat_Waktu: s.tepatWaktu,
            Terlambat: s.terlambat,
            Izin: s.izin,
            Sakit: s.sakit,
            Total_Hadir: s.totalHadir,
            Total_Catatan: s.totalRecorded,
            Persentase_Hadir: `${s.attendanceRate}%`,
          }),
    }));
    const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Rekap_Guru');

    if (filteredRecords.length > 0) {
      const logRows = filteredRecords.map((r, idx) => ({
        No: idx + 1,
        Tanggal: r.date,
        Sesi: r.sessionName || '-',
        NIP: r.nip,
        Nama_Guru: r.teacherName,
        Jam_Masuk: r.timeIn || '-',
        Jam_Pulang: r.timeOut || '-',
        Status: r.status,
        Metode: r.method,
        Catatan: r.notes || '-',
      }));
      const wsLog = XLSX.utils.json_to_sheet(logRows);
      XLSX.utils.book_append_sheet(wb, wsLog, 'Log_Presensi');
    }

    if (recap.dailyBreakdown && recap.dailyBreakdown.length > 0) {
      const wsTrend = XLSX.utils.json_to_sheet(recap.dailyBreakdown);
      XLSX.utils.book_append_sheet(wb, wsTrend, 'Rincian_Tanggal');
    }

    const labelPeriode = period === 'daily' ? 'Harian' : period === 'weekly' ? 'Pekan' : 'Bulanan';
    XLSX.writeFile(wb, `Rekap_Presensi_Guru_${labelPeriode}_${recap.rangeStart}_sd_${recap.rangeEnd}.xlsx`);
  };

  const statusBadge = (status: string) => {
    if (status === 'Tepat Waktu') {
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300';
    }
    if (status === 'Terlambat') {
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300';
    }
    if (status === 'Izin' || status === 'Sakit') {
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300';
    }
    return 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
  };

  return (
    <div className="space-y-6">
      {/* Header & Period Controls */}
      <div className="p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-lg font-black text-slate-900 dark:text-white">
                Rekapitulasi Presensi Guru
              </h3>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Sinkron Real-Time {lastUpdatedAt ? `• ${lastUpdatedAt}` : ''}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Laporan kehadiran guru harian, pekan (Senin–Minggu), dan bulanan yang otomatis sinkron dengan menu Presensi Guru.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Period Switcher */}
            <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              {[
                { id: 'daily', label: 'Harian' },
                { id: 'weekly', label: 'Pekan' },
                { id: 'monthly', label: 'Bulanan' },
              ].map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPeriod(p.id as 'daily' | 'weekly' | 'monthly')}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
                    period === p.id
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleExportExcel}
              disabled={!recap}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm disabled:opacity-50 transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Ekspor Excel</span>
            </button>
          </div>
        </div>

        {/* Date / Week / Month Navigator + Search & Status Filter */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleStepPeriod(-1)}
              className="flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition"
              title="Periode Sebelumnya"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Sebelum</span>
            </button>

            {period === 'monthly' ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                <Calendar className="w-3.5 h-3.5 text-blue-600" />
                <input
                  type="month"
                  value={selectedMonth}
                  onChange={e => e.target.value && setSelectedMonth(e.target.value)}
                  className="text-xs font-bold bg-transparent text-slate-800 dark:text-slate-100 focus:outline-none"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                <Calendar className="w-3.5 h-3.5 text-blue-600" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={e => e.target.value && setSelectedDate(e.target.value)}
                  className="text-xs font-bold bg-transparent text-slate-800 dark:text-slate-100 focus:outline-none"
                />
              </div>
            )}

            <button
              type="button"
              onClick={handleResetToday}
              className="px-3 py-2 rounded-xl text-xs font-bold bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/60 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 transition"
            >
              {period === 'daily' ? 'Hari Ini' : period === 'weekly' ? 'Pekan Ini' : 'Bulan Ini'}
            </button>

            <button
              type="button"
              onClick={() => handleStepPeriod(1)}
              className="flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition"
              title="Periode Sesudahnya"
            >
              <span>Sesudah</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            {recap && (
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 ml-1">
                Rentang: <strong className="text-slate-800 dark:text-slate-200">{formatTanggalIndo(recap.rangeStart)}</strong>
                {recap.rangeStart !== recap.rangeEnd && (
                  <>
                    {' '}– <strong className="text-slate-800 dark:text-slate-200">{formatTanggalIndo(recap.rangeEnd)}</strong>
                  </>
                )}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Cari nama / NIP / mapel..."
                className="pl-8 pr-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>

            {teacherSessions.length > 0 && (
              <select
                value={sessionFilter}
                onChange={e => setSessionFilter(e.target.value)}
                className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
              >
                <option value="ALL">Semua Sesi Guru</option>
                {teacherSessions.map(ses => (
                  <option key={ses.id} value={ses.id}>
                    {ses.name} ({ses.startTime}–{ses.endTime})
                  </option>
                ))}
              </select>
            )}

            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            >
              <option value="ALL">Semua Status</option>
              <option value="Tepat Waktu">Tepat Waktu</option>
              <option value="Terlambat">Terlambat</option>
              <option value="Izin">Izin</option>
              <option value="Sakit">Sakit</option>
              <option value="Belum Presensi">Belum Presensi</option>
            </select>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      {recap && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
            <div className="text-[11px] font-semibold text-slate-400">Total Guru Aktif</div>
            <div className="text-2xl font-black text-slate-900 dark:text-white mt-1">{recap.totals.totalTeachers}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{recap.totals.totalRecords} catatan presensi</div>
          </div>

          <div className="p-4 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
            <div className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">Tepat Waktu</div>
            <div className="text-2xl font-black text-emerald-700 dark:text-emerald-300 mt-1">{recap.totals.tepatWaktu}</div>
            <div className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">Kehadiran penuh</div>
          </div>

          <div className="p-4 rounded-2xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
            <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">Terlambat</div>
            <div className="text-2xl font-black text-amber-700 dark:text-amber-300 mt-1">{recap.totals.terlambat}</div>
            <div className="text-[11px] text-amber-600/80 dark:text-amber-400/80 mt-0.5">Melewati batas masuk</div>
          </div>

          <div className="p-4 rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900">
            <div className="text-[11px] font-semibold text-blue-700 dark:text-blue-300">Izin / Sakit</div>
            <div className="text-2xl font-black text-blue-700 dark:text-blue-300 mt-1">
              {recap.totals.izin + recap.totals.sakit}
            </div>
            <div className="text-[11px] text-blue-600/80 dark:text-blue-400/80 mt-0.5">
              {recap.totals.izin} Izin • {recap.totals.sakit} Sakit
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs col-span-2 sm:col-span-1">
            <div className="text-[11px] font-semibold text-slate-400">
              {period === 'daily' ? 'Belum Presensi' : 'Tingkat Hadir'}
            </div>
            <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 mt-1">
              {period === 'daily' ? recap.totals.belumPresensi : `${recap.totals.attendanceRate}%`}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {period === 'daily'
                ? `${recap.totals.attendanceRate}% hadir hari ini`
                : `${recap.totals.hadirTotal} kali hadir tercatat`}
            </div>
          </div>
        </div>
      )}

      {/* Weekly / Monthly Daily Breakdown Strip */}
      {recap && period !== 'daily' && recap.dailyBreakdown.length > 0 && (
        <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Ringkasan Per Tanggal ({recap.dailyBreakdown.length} Hari)
            </h4>
            <span className="text-[11px] text-slate-400">Klik tanggal untuk lihat rekap harian</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
            {recap.dailyBreakdown.map(day => (
              <button
                key={day.date}
                type="button"
                onClick={() => {
                  setSelectedDate(day.date);
                  setPeriod('daily');
                }}
                className="p-2.5 rounded-2xl bg-slate-50 hover:bg-blue-50 dark:bg-slate-800/70 dark:hover:bg-blue-950/40 border border-slate-200/80 dark:border-slate-700 text-left transition"
              >
                <div className="text-[11px] font-bold text-slate-800 dark:text-slate-100">{formatTanggalIndo(day.date)}</div>
                <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] font-semibold">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    H:{day.tepatWaktu}
                  </span>
                  {day.terlambat > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      T:{day.terlambat}
                    </span>
                  )}
                  {day.izin + day.sakit > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                      I/S:{day.izin + day.sakit}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Teacher Recap Table */}
      <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-bold text-slate-900 dark:text-white">
            {period === 'daily'
              ? `Daftar Kehadiran Guru (${formatTanggalIndo(selectedDate)})`
              : period === 'weekly'
              ? 'Rekapitulasi Kehadiran Guru Mingguan'
              : 'Rekapitulasi Kehadiran Guru Bulanan'}
          </h4>
          <span className="text-xs text-slate-400">{filteredSummaries.length} Guru</span>
        </div>

        {loading && !recap ? (
          <TableSkeleton />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                  <th className="py-3 px-3">Guru & NIP</th>
                  <th className="py-3 px-3">Mapel</th>
                  {period === 'daily' ? (
                    <>
                      <th className="py-3 px-3">Jam Masuk</th>
                      <th className="py-3 px-3">Jam Pulang</th>
                      <th className="py-3 px-3">Status</th>
                      <th className="py-3 px-3">Metode / Catatan</th>
                    </>
                  ) : (
                    <>
                      <th className="py-3 px-3 text-center">Tepat Waktu</th>
                      <th className="py-3 px-3 text-center">Terlambat</th>
                      <th className="py-3 px-3 text-center">Izin</th>
                      <th className="py-3 px-3 text-center">Sakit</th>
                      <th className="py-3 px-3 text-center">Total Hadir</th>
                      <th className="py-3 px-3 text-center">Tingkat Hadir</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredSummaries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-400">
                      Tidak ada data guru yang sesuai filter.
                    </td>
                  </tr>
                ) : (
                  filteredSummaries.map(row => (
                    <tr key={row.teacherId} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-3 px-3">
                        <div className="font-bold text-slate-900 dark:text-white">{row.teacherName}</div>
                        <div className="text-[11px] font-mono text-slate-400">NIP: {row.nip || '-'}</div>
                      </td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-300">{row.subject || '-'}</td>

                      {period === 'daily' ? (
                        <>
                          <td className="py-3 px-3 font-mono text-slate-700 dark:text-slate-200">
                            {row.latestTimeIn ? (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="w-3 h-3 text-emerald-500" />
                                {row.latestTimeIn}
                              </span>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="py-3 px-3 font-mono text-slate-700 dark:text-slate-200">
                            {row.latestTimeOut || '-'}
                          </td>
                          <td className="py-3 px-3">
                            <span className={`px-2.5 py-1 rounded-md font-bold text-[10px] ${statusBadge(row.latestStatus)}`}>
                              {row.latestStatus}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-slate-500">
                            <div>{row.latestMethod || '-'}</div>
                            {row.notes && <div className="text-[11px] italic text-slate-400">{row.notes}</div>}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="py-3 px-3 text-center font-bold text-emerald-600 dark:text-emerald-400">
                            {row.tepatWaktu}
                          </td>
                          <td className="py-3 px-3 text-center font-bold text-amber-600 dark:text-amber-400">
                            {row.terlambat}
                          </td>
                          <td className="py-3 px-3 text-center font-bold text-blue-600 dark:text-blue-400">
                            {row.izin}
                          </td>
                          <td className="py-3 px-3 text-center font-bold text-purple-600 dark:text-purple-400">
                            {row.sakit}
                          </td>
                          <td className="py-3 px-3 text-center font-black text-slate-900 dark:text-white">
                            {row.totalHadir} <span className="text-[10px] font-normal text-slate-400">/ {row.totalRecorded}</span>
                          </td>
                          <td className="py-3 px-3 text-center">
                            <span className="px-2 py-0.5 rounded-md font-bold text-[11px] bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                              {row.attendanceRate}%
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detailed Log Table for Weekly & Monthly */}
      {recap && period !== 'daily' && (
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">
              Log Detail Presensi Periode Ini
            </h4>
            <span className="text-xs text-slate-400">{filteredRecords.length} Baris</span>
          </div>

          <div className="overflow-x-auto max-h-[380px]">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                  <th className="py-2.5 px-3">Tanggal</th>
                  <th className="py-2.5 px-3">Sesi</th>
                  <th className="py-2.5 px-3">Nama Guru</th>
                  <th className="py-2.5 px-3">Masuk</th>
                  <th className="py-2.5 px-3">Pulang</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Catatan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400">
                      Belum ada log presensi pada periode ini.
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map(rec => (
                    <tr key={rec.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-2.5 px-3 font-semibold text-slate-800 dark:text-slate-200">
                        {formatTanggalIndo(rec.date)}
                      </td>
                      <td className="py-2.5 px-3 text-indigo-600 dark:text-indigo-400 font-semibold">
                        {rec.sessionName || '-'}
                      </td>
                      <td className="py-2.5 px-3 font-bold text-slate-900 dark:text-white">{rec.teacherName}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-300">{rec.timeIn || '-'}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-300">{rec.timeOut || '-'}</td>
                      <td className="py-2.5 px-3">
                        <span className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${statusBadge(rec.status)}`}>
                          {rec.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-500 italic">{rec.notes || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Individual Teacher History Lookup by Date */}
      <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">
              Cek Riwayat Presensi Per Guru (Sesuai Tanggal)
            </h4>
            <p className="text-xs text-slate-500">
              Pilih nama guru untuk memeriksa riwayat kehadiran individu pada tanggal tertentu atau seluruh riwayat.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedTeacherId}
              onChange={e => setSelectedTeacherId(e.target.value)}
              className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            >
              <option value="">-- Pilih Guru --</option>
              {teachers.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.nip || 'Tanpa NIP'})
                </option>
              ))}
            </select>
            <input
              type="date"
              value={individualDateFilter}
              onChange={e => setIndividualDateFilter(e.target.value)}
              className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
              title="Filter tanggal tertentu"
            />
            {individualDateFilter && (
              <button
                type="button"
                onClick={() => setIndividualDateFilter('')}
                className="px-3 py-2 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                Semua Tanggal
              </button>
            )}
          </div>
        </div>

        {selectedTeacherId ? (
          loadingIndividual ? (
            <TableSkeleton />
          ) : (
            <div className="overflow-x-auto max-h-[340px]">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                    <th className="py-2.5 px-3">Tanggal</th>
                    <th className="py-2.5 px-3">Sesi</th>
                    <th className="py-2.5 px-3">Masuk</th>
                    <th className="py-2.5 px-3">Pulang</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Metode &amp; Catatan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(() => {
                    const filteredInd = individualDateFilter
                      ? individualHistory.filter(h => h.date === individualDateFilter)
                      : individualHistory;
                    if (filteredInd.length === 0) {
                      return (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-slate-400">
                            {individualDateFilter
                              ? `Tidak ada catatan presensi pada tanggal ${formatTanggalIndo(individualDateFilter)}.`
                              : 'Belum ada riwayat presensi untuk guru ini.'}
                          </td>
                        </tr>
                      );
                    }
                    return filteredInd.map(h => (
                      <tr key={h.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-white">
                          {formatTanggalIndo(h.date)}
                        </td>
                        <td className="py-2.5 px-3 text-indigo-600 dark:text-indigo-400 font-semibold">
                          {h.sessionName || '-'}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-300">{h.timeIn || '-'}</td>
                        <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-300">{h.timeOut || '-'}</td>
                        <td className="py-2.5 px-3">
                          <span className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${statusBadge(h.status)}`}>
                            {h.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-500">
                          {h.method || '-'} {h.notes ? `• ${h.notes}` : ''}
                        </td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
};


