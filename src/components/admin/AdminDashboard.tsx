import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  Lock,
  Copy,
  FileCode2,
  BookOpen,
  Table,
  UserCog,
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
} from '../../types/index.ts';
import { gasGet, gasPost, getWibTodayStr } from '../../lib/api.ts';
import { getGasConfig, isGasConfigured } from '../../lib/gasConfig.ts';
import { APPS_SCRIPT_CODE, APPS_SCRIPT_DEPLOY_GUIDE } from '../../lib/appsScriptTemplate.ts';
import {
  loadFaceDetectionModels,
  areFaceModelsLoaded,
  acquireCameraStream,
  attachStreamToVideo,
  detectSingleFaceDescriptor,
  detectFaceDescriptorFromImage,
  parseCameraError,
} from '../../lib/faceDetection.ts';
import { TableSkeleton } from '../common/Skeleton.tsx';
import { ConfirmModal } from '../common/ConfirmModal.tsx';
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
    gasConfigured,
    saveStatus,
    saveMessage,
  } = useSync();

  // Tabs
  const [activeTab, setActiveTab] = useState<
    'settings' | 'users' | 'face_db' | 'locations' | 'classes' | 'students' | 'bulk_upload' | 'id_cards' | 'teacher_recap' | 'audit_log'
  >('settings');

  // Settings form
  const [settingsForm, setSettingsForm] = useState<Partial<SchoolSettings>>({});
  const [settingsSaved, setSettingsSaved] = useState<boolean>(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Google Apps Script status & auto-provision
  const gasCfgSnapshot = getGasConfig();
  const [gasConfigMsg, setGasConfigMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showScriptPanel, setShowScriptPanel] = useState<boolean>(false);
  const [scriptDocTab, setScriptDocTab] = useState<'code' | 'guide'>('code');
  const [copiedScriptTab, setCopiedScriptTab] = useState<'code' | 'guide' | null>(null);
  const [isProvisioningDb, setIsProvisioningDb] = useState<boolean>(false);

  const handleDataMutated = useCallback(async () => {
    await notifyFaceDatabaseChanged();
  }, [notifyFaceDatabaseChanged]);

  useEffect(() => {
    if (settings) {
      setSettingsForm(settings);
    }
  }, [settings]);

  // Save Settings (with changed_at conflict protection)
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const ok = await updateSettings(settingsForm);
      if (ok) {
        setSettingsSaved(true);
        setTimeout(() => setSettingsSaved(false), 3000);
      } else {
        setSettingsError('Gagal memperbarui pengaturan sekolah.');
      }
    } catch (err: any) {
      setSettingsError(err?.message || 'Gagal menyimpan pengaturan ke Google Sheets.');
    }
  };

  // Auto-create Spreadsheet & Drive folders if missing
  const handleAutoProvisionDatabase = async () => {
    setIsProvisioningDb(true);
    try {
      const prov = await gasPost<{
        spreadsheetName?: string;
        folderName?: string;
        createdSpreadsheet?: boolean;
        createdDriveFolder?: boolean;
        message?: string;
      }>('setupDatabase', {
        spreadsheetName: `Database Presensi - ${settings?.schoolName || 'Yayasan Mambaul Ulum'}`,
        folderName: `Database Presensi - ${settings?.schoolName || 'Yayasan Mambaul Ulum'}`,
      });

      if (prov.success) {
        setGasConfigMsg({
          type: 'success',
          text:
            prov.message ||
            'Database Google Sheets & Folder Drive (termasuk subfolder Database Wajah) siap digunakan!',
        });
        await notifyFaceDatabaseChanged();
      }
    } catch (err: any) {
      setGasConfigMsg({
        type: 'error',
        text: err?.message || 'Gagal membuat database Sheet & Drive otomatis.',
      });
    } finally {
      setIsProvisioningDb(false);
    }
  };

  const handleCopyScriptText = async (type: 'code' | 'guide') => {
    try {
      const content = type === 'code' ? APPS_SCRIPT_CODE : APPS_SCRIPT_DEPLOY_GUIDE;
      await navigator.clipboard.writeText(content);
      setCopiedScriptTab(type);
      setTimeout(() => setCopiedScriptTab(null), 2500);
    } catch {
      setGasConfigMsg({ type: 'error', text: 'Gagal menyalin ke clipboard browser.' });
    }
  };

  // Download Student & Teacher Template (.xlsx)
  const handleDownloadTemplate = () => {
    // Student template sheet
    const studentSample = [
      {
        nis: '10202610',
        nisn: '0071234580',
        nama: 'Ahmad Zaki Fauzan',
        jenisKelamin: 'L',
        classId: classes[0]?.id || 'cls-10-rpl-1',
        barcodeCard: 'CARD-10202610',
        noHpOrtu: '081234567890',
      },
      {
        nis: '10202611',
        nisn: '0071234581',
        nama: 'Nabila Putri Cahyani',
        jenisKelamin: 'P',
        classId: classes[0]?.id || 'cls-10-rpl-1',
        barcodeCard: 'CARD-10202611',
        noHpOrtu: '081234567891',
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
    XLSX.writeFile(wb, 'Template_Import_Presensi_Sekolah.xlsx');
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-bold text-xl shadow-md">
            <Shield className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight">
              Panel Administrator Utama
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Konfigurasi Sekolah, Manajemen Pengguna, Biometric Wajah, dan Database Google Sheets
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          {saveStatus === 'saving' && (
            <span className="px-3 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 font-bold">
              Menyimpan...
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 font-bold">
              Tersimpan
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

      {/* Admin Navigation Pills */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
        {[
          { id: 'settings', label: 'Pengaturan & Apps Script', icon: <Settings className="w-4 h-4" /> },
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
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition ${
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

      {/* Tab 1: Settings + Google Apps Script Configuration & Script Code */}
      {activeTab === 'settings' && (
        <div className="space-y-6 max-w-4xl">
          {/* Card 1: Status Koneksi Google Apps Script (Dikelola di Menu Superadmin) */}
          <div className="p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <FileCode2 className="w-5 h-5 text-blue-600" />
                  <span>Status Koneksi Google Apps Script & Database</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Pengaturan & penguncian URL Web App dan Token rahasia dikelola khusus di <strong>Menu Superadmin</strong> (ikon orang kecil di pojok kanan atas).
                </p>
              </div>

              {gasConfigured && isGasConfigured() ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Apps Script Aktif
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                  Belum Dikonfigurasi
                </span>
              )}
            </div>

            {gasConfigMsg && (
              <div
                className={`p-3.5 rounded-2xl border text-xs flex items-center gap-2 ${
                  gasConfigMsg.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                    : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                }`}
              >
                {gasConfigMsg.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                )}
                <span>{gasConfigMsg.text}</span>
              </div>
            )}

            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5">
                <UserCog className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                <div>
                  <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <span>Konfigurasi URL &amp; Token:</span>
                    <span className={gasCfgSnapshot.locked ? 'text-emerald-600' : 'text-amber-600'}>
                      {gasCfgSnapshot.locked ? 'Terkunci & Aktif Lintas Perangkat' : 'Belum Dikunci'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Untuk mengubah atau membagikan tautan terkunci Vercel, masuk melalui ikon orang kecil (Menu Superadmin).
                  </div>
                </div>
              </div>
              {gasCfgSnapshot.locked && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 font-bold text-[11px]">
                  <Lock className="w-3 h-3" />
                  Terkunci
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {isGasConfigured() && (
                <button
                  type="button"
                  disabled={isProvisioningDb}
                  onClick={() => void handleAutoProvisionDatabase()}
                  className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm disabled:opacity-50 transition"
                >
                  <Table className="w-3.5 h-3.5" />
                  <span>{isProvisioningDb ? 'Menyiapkan Sheet & Drive...' : 'Buat / Siapkan Database Sheet & Drive'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowScriptPanel(prev => !prev)}
                className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold rounded-xl bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 transition"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>{showScriptPanel ? 'Tutup Kode & Petunjuk Deploy' : 'Lihat Kode Apps Script & Petunjuk Deploy'}</span>
              </button>
            </div>

            {showScriptPanel && (
              <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
                    <button
                      type="button"
                      onClick={() => setScriptDocTab('code')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                        scriptDocTab === 'code'
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      Kode Lengkap Code.gs
                    </button>
                    <button
                      type="button"
                      onClick={() => setScriptDocTab('guide')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                        scriptDocTab === 'guide'
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      Petunjuk Deploy
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleCopyScriptText(scriptDocTab)}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white transition"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>
                      {copiedScriptTab === scriptDocTab
                        ? 'Berhasil Disalin!'
                        : scriptDocTab === 'code'
                        ? 'Salin Code.gs'
                        : 'Salin Petunjuk Deploy'}
                    </span>
                  </button>
                </div>

                <pre className="p-4 rounded-2xl bg-slate-950 text-slate-100 text-[11px] font-mono overflow-x-auto max-h-80 leading-relaxed">
                  {scriptDocTab === 'code' ? APPS_SCRIPT_CODE : APPS_SCRIPT_DEPLOY_GUIDE}
                </pre>
              </div>
            )}
          </div>

          {/* Card 2: School System Settings */}
          <div className="p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-6">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Pengaturan Sistem Presensi</h3>
            <p className="text-xs text-slate-500">
              Konfigurasi jam masuk, toleransi terlambat, batas toilet, dan tahun ajaran
            </p>
          </div>

          {settingsSaved && (
            <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-600" />
              <span>Pengaturan sekolah berhasil diperbarui di Google Sheets!</span>
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
                  onChange={e => setSettingsForm({ ...settingsForm, schoolName: e.target.value })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, academicYear: e.target.value })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, foundationAddress: e.target.value })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, foundationWebsite: e.target.value })}
                  placeholder="https://mambaululum.sch.id"
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Watermark Background Kartu (Global URL / Data Image)
                </label>
                <input
                  type="text"
                  value={settingsForm.foundationWatermarkUrl || ''}
                  onChange={e => setSettingsForm({ ...settingsForm, foundationWatermarkUrl: e.target.value })}
                  placeholder="https://... atau upload via tab Cetak Kartu"
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Jam Mulai Presensi Masuk (WIB)
                </label>
                <input
                  type="time"
                  value={settingsForm.checkInTime || '07:00'}
                  onChange={e => setSettingsForm({ ...settingsForm, checkInTime: e.target.value })}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Batas Akhir Hadir Tepat Waktu (Cutoff Terlambat)
                </label>
                <input
                  type="time"
                  value={settingsForm.lateCutoffTime || '07:15'}
                  onChange={e => setSettingsForm({ ...settingsForm, lateCutoffTime: e.target.value })}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Jam Pulang Sekolah
                </label>
                <input
                  type="time"
                  value={settingsForm.checkOutTime || '15:00'}
                  onChange={e => setSettingsForm({ ...settingsForm, checkOutTime: e.target.value })}
                  className="w-full px-4 py-2.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Waktu Izin Toilet BAB (Menit)
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={settingsForm.toiletBabMinutes ?? 10}
                  onChange={e => setSettingsForm({ ...settingsForm, toiletBabMinutes: Number(e.target.value) })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, toiletBakMinutes: Number(e.target.value) })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, toiletMaxMinutes: Number(e.target.value) })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, warningThresholdAbsent: Number(e.target.value) })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, warningThresholdLate: Number(e.target.value) })}
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
                  onChange={e => setSettingsForm({ ...settingsForm, parentNotificationEnabled: e.target.checked })}
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
                className="px-6 py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-md shadow-blue-500/25 transition"
              >
                Simpan Pengaturan Sekolah
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
          classes={classes}
          activeUsers={activeUsers}
          currentUserId={user?.id}
          onRefresh={handleDataMutated}
        />
      )}

      {/* Tab 3: Face Database Registration */}
      {activeTab === 'face_db' && (
        <FaceDatabaseSection
          students={students}
          classes={classes}
          teachers={teachers}
          faceTemplates={faceTemplates}
          onRefresh={handleDataMutated}
        />
      )}

      {/* Tab 4: Locations Settings */}
      {activeTab === 'locations' && (
        <LocationsSection
          locations={locations}
          onRefresh={handleDataMutated}
        />
      )}

      {/* Tab 5: Classes & Promotion (Naik Kelas) */}
      {activeTab === 'classes' && (
        <ClassesSection
          classes={classes}
          teachers={teachers}
          students={students}
          onRefresh={handleDataMutated}
        />
      )}

      {/* Tab 6: Students CRUD */}
      {activeTab === 'students' && (
        <StudentsSection
          students={students}
          classes={classes}
          onRefresh={handleDataMutated}
        />
      )}

      {/* Tab 7: Bulk Upload Students */}
      {activeTab === 'bulk_upload' && (
        <BulkUploadSection
          classes={classes}
          onDownloadTemplate={handleDownloadTemplate}
          onRefresh={handleDataMutated}
        />
      )}

      {/* Tab 8: Bulk ID Cards & JPG Generator Multi-Jenjang */}
      {activeTab === 'id_cards' && (
        <StudentCardManager
          students={students}
          classes={classes}
          schoolName={settings?.schoolName || 'Yayasan Mambaul Ulum'}
          schoolAddress={settings?.foundationAddress}
          foundationWebsite={settings?.foundationWebsite}
          watermarkUrl={settings?.foundationWatermarkUrl}
          faceTemplates={faceTemplates}
          onUpdateSettings={updateSettings}
          initialLevelConfigsJson={settings?.levelConfigsJson}
        />
      )}

      {/* Tab 9: Rekap Presensi Guru (Harian, Pekan, Bulanan - Sinkron Real-Time) */}
      {activeTab === 'teacher_recap' && (
        <TeacherRecapSection serverVersion={serverVersion} teachers={teachers} />
      )}

      {/* Tab 10: Sheet Log */}
      {activeTab === 'audit_log' && (
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Riwayat Perubahan Database (Sheet Log)</h3>
            <div className="flex items-center gap-2">
              {gasConfigured && isGasConfigured() && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-[11px] font-bold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Apps Script Aktif
                </span>
              )}
              <span className="text-xs text-slate-500">100 Log Terbaru</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                  <th className="py-3 px-3">Waktu</th>
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
                      {new Date(log.createdAt).toLocaleString('id-ID')}
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

// Face Database Enrollment
const FaceDatabaseSection: React.FC<{
  students: Student[];
  classes: SchoolClass[];
  teachers: Teacher[];
  faceTemplates: FaceTemplate[];
  onRefresh: () => void | Promise<void>;
}> = ({ students, classes, teachers, faceTemplates, onRefresh }) => {
  const [selectedPersonType, setSelectedPersonType] = useState<'student' | 'teacher'>('student');
  const [selectedPersonId, setSelectedPersonId] = useState<string>('');
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [searchList, setSearchList] = useState<string>('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; updatedAt?: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const photoUploadRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef<boolean>(true);

  const enrolledPersonIds = new Set(faceTemplates.map(f => f.personId));

  useEffect(() => {
    mountedRef.current = true;
    if (!areFaceModelsLoaded()) {
      loadFaceDetectionModels().catch(() => {});
    }
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, []);

  const startCamera = async (modeOverride?: 'user' | 'environment') => {
    const targetMode = modeOverride || facingMode;
    setMessage(null);
    setIsCameraActive(true);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      if (!areFaceModelsLoaded()) {
        loadFaceDetectionModels().catch(() => {});
      }
      const stream = await acquireCameraStream(targetMode);
      if (!mountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        await attachStreamToVideo(videoRef.current, stream);
        if (!mountedRef.current) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
      }
      if (!mountedRef.current) return;
      setIsCameraActive(true);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setIsCameraActive(false);
      const parsed = parseCameraError(e);
      setMessage({ type: 'error', text: `${parsed.title}: ${parsed.message}` });
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  };

  const switchCamera = () => {
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    if (isCameraActive) {
      startCamera(nextMode);
    }
  };

  const saveDescriptorAndPortrait = async (
    descriptor: number[],
    sourceEl: HTMLVideoElement | HTMLImageElement,
    sourceWidth: number,
    sourceHeight: number
  ) => {
    let uploadedFileId: string | undefined;

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

          let neatFileName = `${selectedPersonType}_${selectedPersonId}.jpg`;
          if (selectedPersonType === 'student') {
            const stObj = students.find(s => s.id === selectedPersonId);
            if (stObj) {
              const clsObj = classes.find(c => c.id === stObj.classId);
              const clsPart = (clsObj?.name || stObj.level || 'Siswa').replace(/[\\/:*?"<>|]+/g, ' ').trim();
              const nisPart = (stObj.nis || stObj.id).replace(/[\\/:*?"<>|]+/g, ' ').trim();
              const namePart = stObj.name.replace(/[\\/:*?"<>|]+/g, ' ').trim();
              neatFileName = `${clsPart} - ${nisPart} - ${namePart} - Wajah.jpg`;
            }
          } else {
            const tchObj = teachers.find(t => t.id === selectedPersonId);
            if (tchObj) {
              const nipPart = (tchObj.nip || 'TanpaNIP').replace(/[\\/:*?"<>|]+/g, ' ').trim();
              const namePart = tchObj.name.replace(/[\\/:*?"<>|]+/g, ' ').trim();
              neatFileName = `${nipPart} - ${namePart} - Wajah.jpg`;
            }
          }

          const uploadRes = await gasPost<{ fileId: string; fileName?: string; folderName?: string }>('uploadPhoto', {
            base64Data: portraitDataUrl,
            mimeType: 'image/jpeg',
            fileName: neatFileName,
            personType: selectedPersonType,
            personId: selectedPersonId,
            targetType: selectedPersonType,
            targetId: selectedPersonId,
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
        personId: selectedPersonId,
        personType: selectedPersonType,
        descriptor,
        photoFileId: uploadedFileId,
      });

      if (res.success) {
        setMessage({
          type: 'success',
          text: 'Wajah & foto Drive privat tersimpan rapi ke subfolder Drive dan langsung tersinkron!',
        });
        stopCamera();
        await onRefresh();
      } else {
        setMessage({ type: 'error', text: res.error || 'Gagal menyimpan template wajah.' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Gagal menyimpan template wajah.' });
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
        s.nis.includes(searchList)
      )
    : teachers.filter(t =>
        !searchList ||
        t.name.toLowerCase().includes(searchList.toLowerCase()) ||
        t.nip.includes(searchList)
      );

  const studentTemplatesCount = faceTemplates.filter(f => !f.personType || f.personType === 'student').length;
  const teacherTemplatesCount = faceTemplates.filter(f => f.personType === 'teacher').length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Enrollment Card */}
      <div className="lg:col-span-6 p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Pendaftaran Wajah Baru (Biometric)</h3>
          <p className="text-xs text-slate-500">
            Vektor wajah 128 angka otomatis tersinkron real-time ke Kios Presensi Siswa & Presensi Guru.
          </p>
        </div>

        {message && (
          <div
            className={`p-3 rounded-xl text-xs font-medium ${
              message.type === 'error'
                ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
                : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
            }`}
          >
            {message.text}
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
              Wajah Guru ({teacherTemplatesCount})
            </button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Pilih {selectedPersonType === 'student' ? 'Siswa' : 'Guru'}
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
                : teachers.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name} {enrolledPersonIds.has(t.id) ? '✓ (Terdaftar)' : '✗ (Belum)'}
                    </option>
                  ))}
            </select>
          </div>

          {/* Camera preview */}
          <div className="relative rounded-2xl overflow-hidden bg-slate-900 border border-slate-800 min-h-[260px] flex items-center justify-center">
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ transform: 'none' }}
              className={`w-full max-w-sm rounded-xl ${isCameraActive ? 'block' : 'hidden'}`}
            />
            {!isCameraActive && (
              <div className="text-center p-6 space-y-3">
                <Camera className="w-10 h-10 text-slate-500 mx-auto" />
                <p className="text-xs text-slate-400">
                  Pilih nama terlebih dahulu, lalu nyalakan kamera atau upload foto wajah
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    disabled={!selectedPersonId || isCapturing}
                    className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl disabled:opacity-50"
                  >
                    Nyalakan Kamera
                  </button>
                  <label
                    className={`px-4 py-2 text-xs font-bold rounded-xl border border-slate-600 text-slate-200 hover:bg-slate-800 cursor-pointer transition ${
                      !selectedPersonId || isCapturing ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    <span>{isCapturing ? 'Memproses Foto...' : 'Upload Foto Wajah'}</span>
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
                disabled={isCapturing}
                className="flex-1 py-3 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow transition"
              >
                {isCapturing ? 'Mengekstrak Vektor...' : 'Ambil Foto & Simpan Vektor'}
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
                Batal
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right List: Status Terdaftar / Belum */}
      <div className="lg:col-span-6 p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-base font-bold text-slate-900 dark:text-white">
            Database Wajah {selectedPersonType === 'student' ? 'Siswa' : 'Guru'} ({selectedPersonType === 'student' ? studentTemplatesCount : teacherTemplatesCount} Terdaftar)
          </h3>
          <input
            type="text"
            value={searchList}
            onChange={e => setSearchList(e.target.value)}
            placeholder={selectedPersonType === 'student' ? 'Cari siswa / NIS...' : 'Cari guru / NIP...'}
            className="px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
          />
        </div>

        <div className="space-y-2 max-h-[500px] overflow-y-auto">
          {displayList.map((person: any) => {
            const isEnrolled = enrolledPersonIds.has(person.id);
            const template = faceTemplates.find(f => f.personId === person.id);
            const codeLabel = selectedPersonType === 'student' ? `NIS: ${person.nis} • Siswa` : `NIP: ${person.nip} • Guru`;
            return (
              <div
                key={person.id}
                className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs"
              >
                <div>
                  <div className="font-bold text-slate-900 dark:text-white">{person.name}</div>
                  <div className="text-[11px] text-slate-400">{codeLabel}</div>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-md font-semibold text-[10px] ${
                      isEnrolled
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                    }`}
                  >
                    {isEnrolled ? 'Terdaftar & Sinkron' : 'Belum'}
                  </span>

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
            await gasPost('softDeleteRecord', {
              entity: 'FaceTemplates',
              id: deleteTarget.id,
              expectedUpdatedAt: deleteTarget.updatedAt,
            });
            setMessage({ type: 'success', text: `Data wajah ${deleteTarget.name} berhasil dihapus.` });
            setDeleteTarget(null);
            await onRefresh();
          } catch (err: any) {
            setMessage({ type: 'error', text: err?.message || 'Gagal menghapus data wajah.' });
            setDeleteTarget(null);
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
  classes: SchoolClass[];
  activeUsers: Array<{ userId: string; activeTab: string; deviceLabel: string }>;
  currentUserId?: string;
  onRefresh: () => void;
}> = ({ users, classes, activeUsers, currentUserId, onRefresh }) => {
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

  const onlineUserIds = new Set(activeUsers.map(a => a.userId));

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserFeedback(null);
    try {
      const res = await gasPost('createRecord', {
        entity: 'Users',
        data: { username, password, name, role, classId, email, nip, subject },
      });
      if (res.success) {
        setShowModal(false);
        setUsername('');
        setPassword('');
        setName('');
        setEmail('');
        setNip('');
        setSubject('');
        setClassId('');
        setUserFeedback({ type: 'success', text: `Akun "${name}" berhasil ditambahkan dan langsung disinkronkan.` });
        onRefresh();
      } else {
        setUserFeedback({ type: 'error', text: res.error || 'Gagal membuat pengguna' });
      }
    } catch (e: any) {
      setUserFeedback({ type: 'error', text: e.message || 'Gagal membuat pengguna' });
    }
  };

  const handleToggleActive = async (targetUser: any) => {
    setUserFeedback(null);
    try {
      const nextActive = !targetUser.isActive;
      const res = await gasPost('updateRecord', {
        entity: 'Users',
        id: targetUser.id,
        data: { isActive: nextActive },
        expectedUpdatedAt: targetUser.diubah_pada || targetUser.updatedAt,
      });
      if (res.success) {
        setUserFeedback({
          type: 'success',
          text: `Status akun "${targetUser.name}" diubah menjadi ${nextActive ? 'Aktif' : 'Nonaktif'}.`,
        });
        onRefresh();
      }
    } catch (e: any) {
      setUserFeedback({ type: 'error', text: e.message || 'Gagal memperbarui status pengguna.' });
    }
  };

  const handleDeleteUser = async (targetUser: any) => {
    setUserFeedback(null);
    try {
      const res = await gasPost('softDeleteRecord', {
        entity: 'Users',
        id: targetUser.id,
        expectedUpdatedAt: targetUser.diubah_pada || targetUser.updatedAt,
      });
      if (res.success) {
        setUserFeedback({ type: 'success', text: `Akun "${targetUser.name}" berhasil dihapus (soft delete).` });
        onRefresh();
      } else {
        setUserFeedback({ type: 'error', text: res.error || 'Gagal menghapus pengguna.' });
      }
    } catch (e: any) {
      setUserFeedback({ type: 'error', text: e.message || 'Gagal menghapus pengguna.' });
    }
  };

  const handleConfirmResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget || resetNewPassword.length < 5) {
      setUserFeedback({ type: 'error', text: 'Password baru minimal 5 karakter.' });
      return;
    }
    try {
      const res = await gasPost('resetUserPassword', {
        id: resetTarget.id,
        newPassword: resetNewPassword,
        expectedUpdatedAt: resetTarget.diubah_pada,
      });
      if (res.success) {
        setUserFeedback({ type: 'success', text: `Kata sandi "${resetTarget.name}" berhasil direset.` });
        setResetTarget(null);
        setResetNewPassword('');
        onRefresh();
      } else {
        setUserFeedback({ type: 'error', text: res.error || 'Gagal mereset kata sandi.' });
      }
    } catch (e: any) {
      setUserFeedback({ type: 'error', text: e.message || 'Gagal mereset kata sandi.' });
    }
  };

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Manajemen Akun Multi-Pengguna</h3>
          <p className="text-xs text-slate-500">
            Kelola akun Admin, Wali Kelas, Guru BK, Kesiswaan & Guru beserta status online real-time
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition"
        >
          <Plus className="w-4 h-4" />
          <span>Tambah Pengguna</span>
        </button>
      </div>

      {userFeedback && (
        <div
          className={`p-3 rounded-2xl text-xs flex items-center gap-2 border ${
            userFeedback.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          {userFeedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
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
              <th className="py-3 px-3">Username</th>
              <th className="py-3 px-3">Peran (Role)</th>
              <th className="py-3 px-3">Kelas Binaan</th>
              <th className="py-3 px-3">Sesi & Status</th>
              <th className="py-3 px-3 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {users.map(u => {
              const isOnline = onlineUserIds.has(u.id);
              const isSelf = u.id === currentUserId;
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
                  <td className="py-3 px-3 font-mono text-slate-500">{u.username}</td>
                  <td className="py-3 px-3">
                    <span className="px-2 py-0.5 rounded-md font-semibold text-[10px] bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                      {u.role}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-slate-500">
                    {classes.find(c => c.id === u.classId)?.name || '-'}
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={isSelf}
                        onClick={() => void handleToggleActive(u)}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold transition ${
                          u.isActive
                            ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950 hover:bg-emerald-100'
                            : 'text-slate-500 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200'
                        } disabled:opacity-60`}
                        title={isSelf ? 'Akun yang sedang digunakan' : 'Klik untuk ubah status aktif/nonaktif'}
                      >
                        {u.isActive ? 'Aktif' : 'Nonaktif'}
                      </button>
                      {isOnline && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-900/40">
                          Online
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right space-x-1">
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
                        onClick={() => void handleDeleteUser(u)}
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

      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-slate-900 p-6 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">
              Reset Kata Sandi: {resetTarget.name}
            </h4>
            <form onSubmit={handleConfirmResetPassword} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Kata Sandi Baru (Minimal 5 karakter)</label>
                <input
                  type="password"
                  value={resetNewPassword}
                  onChange={e => setResetNewPassword(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  minLength={5}
                  required
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-blue-600 text-white font-bold"
                >
                  Simpan Sandi
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4">Tambah Pengguna Baru</h3>
            <form onSubmit={handleCreate} className="space-y-3 text-xs">
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
                <label className="block font-semibold mb-1">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
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
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
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

              {(role === 'guru' || role === 'wali_kelas' || role === 'bk' || role === 'kesiswaan') && (
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
                      placeholder="Contoh: Matematika / Wali Kelas"
                      className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    />
                  </div>
                </div>
              )}

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

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold"
                >
                  Simpan
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
  onRefresh: () => void;
}> = ({ locations, onRefresh }) => {
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radiusMeters, setRadiusMeters] = useState('150');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SchoolLocation | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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

  const handleCreateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await gasPost('createRecord', {
        entity: 'Locations',
        data: {
          name,
          latitude: Number(latitude),
          longitude: Number(longitude),
          radiusMeters: Number(radiusMeters),
        },
      });
      if (res.success) {
        setShowModal(false);
        setName('');
        setLatitude('');
        setLongitude('');
        setFeedback({ type: 'success', text: 'Titik lokasi geofence berhasil disimpan.' });
        onRefresh();
      } else {
        setFeedback({ type: 'error', text: res.error || 'Gagal menyimpan lokasi.' });
      }
    } catch (e: any) {
      setFeedback({ type: 'error', text: e?.message || 'Gagal menyimpan lokasi.' });
    }
  };

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Titik Geofence Presensi Guru</h3>
          <p className="text-xs text-slate-500">Presensi guru hanya diterima jika berada dalam radius titik ini</p>
        </div>
        <button
          onClick={() => {
            setFeedback(null);
            setShowModal(true);
          }}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition"
        >
          <Plus className="w-4 h-4" />
          <span>Tambah Lokasi</span>
        </button>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs font-medium flex items-center justify-between ${
            feedback.type === 'error'
              ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
              : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
          }`}
        >
          <span>{feedback.text}</span>
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
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-slate-900 dark:text-white">{loc.name}</span>
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 font-bold text-[10px]">
                Radius {loc.radiusMeters}m
              </span>
            </div>
            <div className="font-mono text-slate-500 text-[11px]">
              Lat: {loc.latitude}, Lng: {loc.longitude}
            </div>
            <div className="pt-2 flex justify-end">
              <button
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
            await gasPost('softDeleteRecord', {
              entity: 'Locations',
              id: deleteTarget.id,
              expectedUpdatedAt: deleteTarget.diubah_pada || deleteTarget.updatedAt,
            });
            setFeedback({ type: 'success', text: `Lokasi ${deleteTarget.name} berhasil dihapus.` });
            setDeleteTarget(null);
            onRefresh();
          } catch (err: any) {
            setFeedback({ type: 'error', text: err?.message || 'Gagal menghapus lokasi.' });
            setDeleteTarget(null);
          } finally {
            setIsDeleting(false);
          }
        }}
      />

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4">Tambah Titik Lokasi Baru</h3>
            <form onSubmit={handleCreateLocation} className="space-y-3 text-xs">
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
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold"
                >
                  Simpan Lokasi
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
  onRefresh: () => void;
}> = ({ classes, teachers, students, onRefresh }) => {
  const [showModal, setShowModal] = useState(false);
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [className, setClassName] = useState('');
  const [grade, setGrade] = useState('10');
  const [homeRoomTeacherId, setHomeRoomTeacherId] = useState('');
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

  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await gasPost('createRecord', {
        entity: 'Classes',
        data: { name: className, grade, homeRoomTeacherId },
      });
      if (res.success) {
        setShowModal(false);
        setClassName('');
        setHomeRoomTeacherId('');
        setFeedback({ type: 'success', text: 'Kelas baru berhasil disimpan.' });
        onRefresh();
      } else {
        setFeedback({ type: 'error', text: res.error || 'Gagal menyimpan kelas.' });
      }
    } catch (e: any) {
      setFeedback({ type: 'error', text: e?.message || 'Gagal menyimpan kelas.' });
    }
  };

  const handlePromote = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await gasPost('promoteClass', {
        sourceClassId,
        targetClassId,
        action,
      });
      if (res.success) {
        setFeedback({ type: 'success', text: res.message || 'Kenaikan kelas berhasil diproses.' });
        setShowPromoteModal(false);
        onRefresh();
      } else {
        setFeedback({ type: 'error', text: res.error || 'Gagal memproses kenaikan kelas.' });
      }
    } catch (e: any) {
      setFeedback({ type: 'error', text: e?.message || 'Gagal memproses kenaikan kelas.' });
    }
  };

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Manajemen Kelas & Promosi</h3>
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
            onClick={() => {
              setFeedback(null);
              setShowModal(true);
            }}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Kelas</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs font-medium flex items-center justify-between ${
            feedback.type === 'error'
              ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
              : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
          }`}
        >
          <span>{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)} className="font-bold hover:underline">
            Tutup
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {classes.map(c => (
          <div
            key={c.id}
            className="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-black text-sm text-slate-900 dark:text-white">{c.name}</span>
              <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-bold text-[10px]">
                Tingkat {c.grade}
              </span>
            </div>
            <div className="text-slate-500 text-[11px]">
              Wali: {c.homeRoomTeacherName || 'Belum ada'}
            </div>
            <div className="text-slate-500 text-[11px]">
              Jumlah: {students.filter(s => s.classId === c.id && s.isActive).length} Siswa
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4">Tambah Kelas Baru</h3>
            <form onSubmit={handleCreateClass} className="space-y-3 text-xs">
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

              <div>
                <label className="block font-semibold mb-1">Tingkat</label>
                <select
                  value={grade}
                  onChange={e => setGrade(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                >
                  <option value="10">Kelas 10 (Fase E)</option>
                  <option value="11">Kelas 11 (Fase F)</option>
                  <option value="12">Kelas 12 (Fase F Lanjut)</option>
                </select>
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
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold"
                >
                  Simpan Kelas
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPromoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
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
                  onClick={() => setShowPromoteModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-purple-600 text-white font-bold"
                >
                  Proses Kenaikan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// Students Section
const StudentsSection: React.FC<{
  students: Student[];
  classes: SchoolClass[];
  onRefresh: () => void;
}> = ({ students, classes, onRefresh }) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [nis, setNis] = useState('');
  const [nisn, setNisn] = useState('');
  const [gender, setGender] = useState<'L' | 'P'>('L');
  const [classId, setClassId] = useState(classes[0]?.id || '');
  const [barcodeCard, setBarcodeCard] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Student | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!classId && classes.length > 0) {
      setClassId(classes[0].id);
    }
  }, [classes, classId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await gasPost('createRecord', {
        entity: 'Students',
        data: {
          name,
          nis,
          nisn,
          gender,
          classId,
          barcodeCard: barcodeCard || `CARD-${nis}`,
          parentPhone,
        },
      });
      if (res.success) {
        setShowModal(false);
        setName('');
        setNis('');
        setNisn('');
        setBarcodeCard('');
        setParentPhone('');
        setFeedback({ type: 'success', text: 'Data siswa baru berhasil ditambahkan.' });
        onRefresh();
      } else {
        setFeedback({ type: 'error', text: res.error || 'Gagal menambah siswa.' });
      }
    } catch (e: any) {
      setFeedback({ type: 'error', text: e?.message || 'Gagal menambah siswa.' });
    }
  };

  const filtered = students.filter(
    s => s.name.toLowerCase().includes(search.toLowerCase()) || s.nis.includes(search)
  );

  return (
    <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Database Siswa ({students.length})</h3>
          <p className="text-xs text-slate-500">Kelola data induk siswa, barcode kartu, dan nomor kontak orang tua</p>
        </div>
        <div className="flex gap-3 w-full sm:w-auto">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cari siswa atau NIS..."
            className="px-3.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
          />
          <button
            onClick={() => {
              setFeedback(null);
              setShowModal(true);
            }}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Siswa</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-xl text-xs font-medium flex items-center justify-between ${
            feedback.type === 'error'
              ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
              : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900'
          }`}
        >
          <span>{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)} className="font-bold hover:underline">
            Tutup
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
              <th className="py-3 px-3">NIS</th>
              <th className="py-3 px-3">Nama Siswa</th>
              <th className="py-3 px-3">Kelas</th>
              <th className="py-3 px-3">Kode Barcode/RFID</th>
              <th className="py-3 px-3">Wajah</th>
              <th className="py-3 px-3 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map(s => (
              <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="py-3 px-3 font-mono">{s.nis}</td>
                <td className="py-3 px-3 font-bold text-slate-900 dark:text-white">{s.name}</td>
                <td className="py-3 px-3 text-slate-500">{classes.find(c => c.id === s.classId)?.name || '-'}</td>
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
                <td className="py-3 px-3 text-right">
                  <button
                    onClick={() => setDeleteTarget(s)}
                    className="p-1 text-slate-400 hover:text-red-600 transition"
                    title="Hapus siswa"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
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
            await gasPost('softDeleteRecord', {
              entity: 'Students',
              id: deleteTarget.id,
              expectedUpdatedAt: deleteTarget.diubah_pada || deleteTarget.updatedAt,
            });
            setFeedback({ type: 'success', text: `Siswa ${deleteTarget.name} berhasil dihapus.` });
            setDeleteTarget(null);
            onRefresh();
          } catch (err: any) {
            setFeedback({ type: 'error', text: err?.message || 'Gagal menghapus siswa.' });
            setDeleteTarget(null);
          } finally {
            setIsDeleting(false);
          }
        }}
      />

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4">Tambah Siswa Baru</h3>
            <form onSubmit={handleCreate} className="space-y-3 text-xs">
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
                  <label className="block font-semibold mb-1">Kelas</label>
                  <select
                    value={classId}
                    onChange={e => setClassId(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    {classes.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
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
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-blue-600 text-white font-bold"
                >
                  Simpan Siswa
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
  onDownloadTemplate: () => void;
  onRefresh: () => void;
}> = ({ classes, onDownloadTemplate, onRefresh }) => {
  const [selectedClassId, setSelectedClassId] = useState(classes[0]?.id || '');
  const [parsedRows, setParsedRows] = useState<any[]>([]);
  const [errorReport, setErrorReport] = useState<any[]>([]);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (!selectedClassId && classes.length > 0) {
      setSelectedClassId(classes[0].id);
    }
  }, [classes, selectedClassId]);

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
    if (parsedRows.length === 0) return;
    setIsProcessing(true);
    setUploadError(null);
    try {
      const res = await gasPost<{
        importedCount: number;
        errorCount: number;
        errorRows: any[];
        message: string;
      }>('bulkImportStudents', {
        rows: parsedRows,
        classId: selectedClassId,
      });

      if (res.success) {
        setUploadResult(res.message || null);
        setErrorReport(res.errorRows || []);
        onRefresh();
      } else {
        setUploadError(res.error || 'Import gagal.');
      }
    } catch (e: any) {
      setUploadError(e?.message || 'Import gagal.');
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
            Validasi format, deteksi duplikasi NIS/NISN, dan pratinjau tabel sebelum disimpan
          </p>
        </div>

        <button
          onClick={onDownloadTemplate}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 transition"
        >
          <Download className="w-4 h-4" />
          <span>Unduh Template Excel (.xlsx)</span>
        </button>
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
        <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2 border border-emerald-200">
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
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-900 dark:text-white">
              Pratinjau Data ({parsedRows.length} Baris Terdeteksi)
            </span>

            <button
              onClick={handleExecuteImport}
              disabled={isProcessing}
              className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow disabled:opacity-50 transition"
            >
              {isProcessing ? 'Memproses Import...' : 'Simpan Semua ke Database'}
            </button>
          </div>

          <div className="overflow-x-auto max-h-60 border border-slate-200 dark:border-slate-700 rounded-xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                <tr>
                  <th className="p-2.5">NIS</th>
                  <th className="p-2.5">Nama</th>
                  <th className="p-2.5">L/P</th>
                  <th className="p-2.5">No HP Ortu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {parsedRows.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    <td className="p-2.5 font-mono">{r.nis}</td>
                    <td className="p-2.5 font-bold">{r.nama || r.name}</td>
                    <td className="p-2.5">{r.gender || r.jenisKelamin || 'L'}</td>
                    <td className="p-2.5">{r.parentPhone || r.noHpOrtu || '-'}</td>
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
}> = ({ serverVersion, teachers }) => {
  const todayStr = getWibTodayStr();
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [selectedMonth, setSelectedMonth] = useState<string>(todayStr.slice(0, 7));
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
      });
      if (res.success && Array.isArray(res.data)) {
        setIndividualHistory(res.data);
      }
    } catch (err) {
      console.error('Failed to load individual teacher history:', err);
    } finally {
      setLoadingIndividual(false);
    }
  }, [teachers]);

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
          ? { period, month: selectedMonth }
          : { period, date: selectedDate }
      );
      if (res.success && (res as any).totals) {
        const raw = res as unknown as TeacherRecapResponse & { success: boolean };
        setRecap(raw);
        setLastUpdatedAt(new Date().toLocaleTimeString('id-ID'));
      }
    } catch (err) {
      console.error('Failed to load teacher recap:', err);
    } finally {
      setLoading(false);
    }
  }, [period, selectedDate, selectedMonth]);

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
                    <td colSpan={6} className="py-8 text-center text-slate-400">
                      Belum ada log presensi pada periode ini.
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map(rec => (
                    <tr key={rec.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-2.5 px-3 font-semibold text-slate-800 dark:text-slate-200">
                        {formatTanggalIndo(rec.date)}
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
                    <th className="py-2.5 px-3">Masuk</th>
                    <th className="py-2.5 px-3">Pulang</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Metode & Catatan</th>
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
                          <td colSpan={5} className="py-8 text-center text-slate-400">
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


