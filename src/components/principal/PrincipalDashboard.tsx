import React, { useState, useEffect, useCallback } from 'react';
import { useSync } from '../../context/SyncContext.tsx';
import { gasGet, gasPost } from '../../lib/api.ts';
import { getMissingFrontendConfigKeys } from '../../lib/gasConfig.ts';
import { SystemCheckReport } from '../../types/index.ts';
import {
  ShieldCheck,
  Database,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Users,
  GraduationCap,
  Briefcase,
  UserCheck,
  Clock,
  Activity,
  KeyRound,
  LayoutDashboard,
} from 'lucide-react';

export const PrincipalDashboard: React.FC = () => {
  const {
    students,
    classes,
    teachers,
    todayAttendance,
    activePermits,
    faceTemplates,
    settings,
    activeUsers,
    serverVersion,
    lastSyncedAt,
    gasConfigured,
    notifyFaceDatabaseChanged,
  } = useSync();

  const [activeSubTab, setActiveSubTab] = useState<'overview' | 'cek_sistem'>('cek_sistem');
  const [report, setReport] = useState<SystemCheckReport | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [provisionSuccessMsg, setProvisionSuccessMsg] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  const missingFrontendKeys = getMissingFrontendConfigKeys();

  const runSystemCheck = useCallback(async () => {
    if (!gasConfigured) {
      setReport(null);
      setTestError('URL & Token Google Apps Script di sisi aplikasi masih kosong.');
      return;
    }

    setIsTesting(true);
    setTestError(null);
    try {
      const res = await gasGet<SystemCheckReport>('checkSystem');
      setReport(res as unknown as SystemCheckReport);
      setLastCheckedAt(new Date());
    } catch (err: any) {
      setTestError(err?.message || 'Gagal menjalankan pengecekan sistem.');
    } finally {
      setIsTesting(false);
    }
  }, [gasConfigured]);

  const handleAutoProvision = async () => {
    setIsProvisioning(true);
    setTestError(null);
    setProvisionSuccessMsg(null);
    try {
      const res = await gasPost<{ message?: string }>('setupDatabase', {});
      if (res.success) {
        setProvisionSuccessMsg(res.message || 'Spreadsheet & Folder Drive berhasil dibuat otomatis!');
        await notifyFaceDatabaseChanged();
        await runSystemCheck();
      }
    } catch (err: any) {
      setTestError(err?.message || 'Gagal membuat database Sheet & Drive otomatis.');
    } finally {
      setIsProvisioning(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'cek_sistem') {
      void runSystemCheck();
    }
  }, [activeSubTab, runSystemCheck]);

  const activeStudents = students.filter((s) => s.isActive);
  const activeTeachers = teachers.filter((t) => t.isActive);
  const presentCount = todayAttendance.filter(
    (a) => a.status === 'Hadir' || a.status === 'Terlambat'
  ).length;
  const lateCount = todayAttendance.filter((a) => a.status === 'Terlambat').length;
  const enrolledStudentFaces = faceTemplates.filter((f) => f.personType === 'student').length;
  const enrolledTeacherFaces = faceTemplates.filter((f) => f.personType === 'teacher').length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header Banner */}
      <div className="rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-950 to-blue-900 p-6 sm:p-8 text-white shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-xs font-bold text-blue-200 border border-white/15">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Menu Kepala Sekolah • {settings?.schoolName || 'Yayasan Mambaul Ulum'}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
              Dashboard Pimpinan & Cek Sistem
            </h1>
            <p className="text-xs sm:text-sm text-blue-100/80 max-w-2xl">
              Pantau ringkasan kehadiran real-time serta uji koneksi langsung ke Google Sheets dan Google Drive tanpa menampilkan nilai rahasia.
            </p>
          </div>

          <div className="flex items-center gap-2 bg-white/10 p-1.5 rounded-2xl border border-white/15 self-start md:self-center">
            <button
              type="button"
              onClick={() => setActiveSubTab('cek_sistem')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
                activeSubTab === 'cek_sistem'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-white/80 hover:text-white'
              }`}
            >
              <Activity className="w-4 h-4" />
              <span>Cek Sistem</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab('overview')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
                activeSubTab === 'overview'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-white/80 hover:text-white'
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span>Ringkasan Sekolah</span>
            </button>
          </div>
        </div>
      </div>

      {/* TAB 1: CEK SISTEM */}
      {activeSubTab === 'cek_sistem' && (
        <div className="space-y-6">
          {/* Action Header */}
          <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Activity className="w-5 h-5 text-blue-600" />
                <span>Diagnostik Koneksi & Kelengkapan Konfigurasi</span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Memeriksa integritas koneksi Google Sheets, Google Drive, dan mendeteksi bagian konfigurasi yang masih kosong (nilai rahasia tidak pernah ditampilkan).
                {lastCheckedAt ? ` Terakhir diuji: ${lastCheckedAt.toLocaleTimeString('id-ID')}.` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
              {report?.missingConfig &&
                (report.missingConfig.includes('SPREADSHEET_ID') ||
                  report.missingConfig.includes('DRIVE_FOLDER_ID')) && (
                  <button
                    type="button"
                    onClick={() => void handleAutoProvision()}
                    disabled={isProvisioning}
                    className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-md disabled:opacity-50 transition flex items-center gap-2"
                  >
                    <Database className="w-4 h-4" />
                    <span>{isProvisioning ? 'Membuat Sheet & Drive...' : 'Buat Database Sheet & Drive Otomatis'}</span>
                  </button>
                )}

              <button
                type="button"
                onClick={() => void runSystemCheck()}
                disabled={isTesting}
                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-500/20 disabled:opacity-50 transition flex items-center gap-2"
              >
                {isTesting ? (
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Activity className="w-4 h-4" />
                )}
                <span>{isTesting ? 'Menguji Koneksi...' : 'Uji Koneksi Sistem'}</span>
              </button>
            </div>
          </div>

          {provisionSuccessMsg && (
            <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2.5">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600" />
              <span className="font-semibold">{provisionSuccessMsg}</span>
            </div>
          )}

          {testError && (
            <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-start gap-3">
              <XCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-bold">Koneksi Gagal Diuji</div>
                <div className="mt-0.5">{testError}</div>
              </div>
            </div>
          )}

          {/* Grid Status Connections */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Google Sheets Card */}
            <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600">
                    <Database className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-900 dark:text-white">
                      Koneksi Google Sheets
                    </h3>
                    <p className="text-xs text-slate-500">Database Utama Presensi</p>
                  </div>
                </div>
                {report?.sheets ? (
                  report.sheets.ok ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Terhubung
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
                      <XCircle className="w-3.5 h-3.5" />
                      Bermasalah
                    </span>
                  )
                ) : (
                  <span className="text-xs text-slate-400">Menunggu uji...</span>
                )}
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs space-y-2">
                <div className="font-semibold text-slate-700 dark:text-slate-200">
                  {report?.sheets?.message || (isTesting ? 'Menguji akses Spreadsheet...' : 'Belum ada hasil pengujian.')}
                </div>
                {typeof report?.sheets?.sheetCount === 'number' && report.sheets.ok && (
                  <div className="flex items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>Jumlah Sheet: <strong>{report.sheets.sheetCount}</strong></span>
                    {typeof report.sheets.latencyMs === 'number' && (
                      <span>Latensi: <strong>{report.sheets.latencyMs} ms</strong></span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Google Drive Card */}
            <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-3 rounded-2xl bg-blue-50 dark:bg-blue-950/50 text-blue-600">
                    <HardDrive className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-900 dark:text-white">
                      Koneksi Google Drive
                    </h3>
                    <p className="text-xs text-slate-500">Penyimpanan Foto Privat (DriveApp)</p>
                  </div>
                </div>
                {report?.drive ? (
                  report.drive.ok ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Terhubung
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
                      <XCircle className="w-3.5 h-3.5" />
                      Bermasalah
                    </span>
                  )
                ) : (
                  <span className="text-xs text-slate-400">Menunggu uji...</span>
                )}
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs space-y-2">
                <div className="font-semibold text-slate-700 dark:text-slate-200">
                  {report?.drive?.message || (isTesting ? 'Menguji akses Folder Drive...' : 'Belum ada hasil pengujian.')}
                </div>
                {typeof report?.drive?.latencyMs === 'number' && report.drive.ok && (
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Latensi DriveApp: <strong>{report.drive.latencyMs} ms</strong>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Empty Config Keys Detection (NEVER shows secret values!) */}
          <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/50 text-amber-600">
                <KeyRound className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-900 dark:text-white">
                  Pemeriksaan Bagian Konfigurasi Kosong (Script Properties & Frontend)
                </h3>
                <p className="text-xs text-slate-500">
                  Hanya menampilkan nama kunci konfigurasi yang kosong atau status kelengkapannya. Nilai rahasia tidak pernah ditampilkan.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              {/* Frontend keys */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2.5">
                <div className="font-bold text-slate-800 dark:text-white">
                  Konfigurasi Aplikasi (Frontend)
                </div>
                {missingFrontendKeys.length === 0 ? (
                  <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-semibold">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Semua bagian konfigurasi frontend sudah terisi & terkunci.</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold">
                      <AlertTriangle className="w-4 h-4" />
                      <span>Bagian konfigurasi frontend yang masih kosong:</span>
                    </div>
                    <ul className="space-y-1 pl-1">
                      {missingFrontendKeys.map((key) => (
                        <li
                          key={key}
                          className="px-3 py-1.5 rounded-lg bg-amber-100/70 dark:bg-amber-950/50 text-amber-900 dark:text-amber-200 font-mono font-bold"
                        >
                          {key} — KOSONG
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Apps Script Properties keys */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2.5">
                <div className="font-bold text-slate-800 dark:text-white">
                  Script Properties (Google Apps Script)
                </div>
                {!report ? (
                  <div className="text-slate-500">
                    {gasConfigured
                      ? 'Menunggu hasil pembacaan Script Properties dari server...'
                      : 'Hubungkan URL & Token terlebih dahulu untuk memeriksa Script Properties.'}
                  </div>
                ) : report.missingConfig.length === 0 ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-semibold">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Tidak ada Script Properties yang kosong.</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {report.configuredKeys.map((k) => (
                        <span
                          key={k}
                          className="px-2.5 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-mono font-bold"
                        >
                          ✓ {k}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold">
                      <AlertTriangle className="w-4 h-4" />
                      <span>Bagian Script Properties yang masih kosong:</span>
                    </div>
                    <ul className="space-y-1 pl-1">
                      {report.missingConfig.map((key) => (
                        <li
                          key={key}
                          className="px-3 py-1.5 rounded-lg bg-red-100/80 dark:bg-red-950/50 text-red-900 dark:text-red-200 font-mono font-bold"
                        >
                          {key} — KOSONG
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: RINGKASAN SEKOLAH */}
      {activeSubTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Siswa Aktif</span>
                <GraduationCap className="w-5 h-5 text-blue-600" />
              </div>
              <div className="text-2xl font-black text-slate-900 dark:text-white">
                {activeStudents.length}
              </div>
              <div className="text-[11px] text-slate-500">
                {classes.length} kelas • {enrolledStudentFaces} wajah terdaftar
              </div>
            </div>

            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Hadir Hari Ini</span>
                <UserCheck className="w-5 h-5 text-emerald-600" />
              </div>
              <div className="text-2xl font-black text-emerald-600">
                {presentCount}
              </div>
              <div className="text-[11px] text-slate-500">
                {lateCount} terlambat • Dari {activeStudents.length} siswa
              </div>
            </div>

            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Guru Aktif</span>
                <Briefcase className="w-5 h-5 text-indigo-600" />
              </div>
              <div className="text-2xl font-black text-slate-900 dark:text-white">
                {activeTeachers.length}
              </div>
              <div className="text-[11px] text-slate-500">
                {enrolledTeacherFaces} wajah guru terdaftar
              </div>
            </div>

            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Izin Toilet & Sesi</span>
                <Clock className="w-5 h-5 text-amber-600" />
              </div>
              <div className="text-2xl font-black text-amber-600">
                {activePermits.length}
              </div>
              <div className="text-[11px] text-slate-500">
                {activeUsers.length} perangkat aktif • Versi DB v{serverVersion}
              </div>
            </div>
          </div>

          <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-blue-600" />
                <span>Log Kehadiran Siswa Terbaru Hari Ini</span>
              </h3>
              <span className="text-[11px] text-slate-400">
                {lastSyncedAt ? `Sinkron otomatis: ${lastSyncedAt.toLocaleTimeString('id-ID')}` : ''}
              </span>
            </div>

            {todayAttendance.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                Belum ada data presensi siswa hari ini.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-500">
                      <th className="py-2 pr-3 font-bold">Nama Siswa</th>
                      <th className="py-2 pr-3 font-bold">NIS</th>
                      <th className="py-2 pr-3 font-bold">Kelas</th>
                      <th className="py-2 pr-3 font-bold">Waktu Masuk</th>
                      <th className="py-2 font-bold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {todayAttendance.slice(0, 15).map((row) => (
                      <tr key={row.id}>
                        <td className="py-2.5 pr-3 font-bold text-slate-900 dark:text-white">
                          {row.studentName || '-'}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-slate-500">{row.studentNis || '-'}</td>
                        <td className="py-2.5 pr-3 text-slate-600 dark:text-slate-300">{row.className || '-'}</td>
                        <td className="py-2.5 pr-3 font-mono text-slate-700 dark:text-slate-300">{row.timeIn}</td>
                        <td className="py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                              row.status === 'Hadir'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                                : row.status === 'Terlambat'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                                : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            }`}
                          >
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
