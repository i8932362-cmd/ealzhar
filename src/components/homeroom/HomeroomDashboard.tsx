import React, { useState, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  Users,
  FileSpreadsheet,
  Printer,
  Search,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useSync } from '../../context/SyncContext.tsx';
import { Student, StudentAttendance } from '../../types/index.ts';
import { gasGet, postWithOfflineFallback, getWibTodayStr } from '../../lib/api.ts';

export const HomeroomDashboard: React.FC = () => {
  const { user } = useAuth();
  const {
    classes,
    students: allStudents,
    todayAttendance,
    activePermits,
    settings,
    activeStudentSession,
    serverDate,
    notifyFaceDatabaseChanged,
  } = useSync();

  const [selectedClassId, setSelectedClassId] = useState<string>('');
  const [reportType, setReportType] = useState<'today' | 'weekly' | 'monthly' | 'compare'>('today');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [detailStudent, setDetailStudent] = useState<Student | null>(null);

  // Correction Modal
  const [correctionTarget, setCorrectionTarget] = useState<StudentAttendance | null>(null);
  const [correctionStatus, setCorrectionStatus] = useState<'Hadir' | 'Terlambat' | 'Izin' | 'Sakit' | 'Alpa'>('Hadir');
  const [correctionReason, setCorrectionReason] = useState<string>('');
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [isSubmittingCorrection, setIsSubmittingCorrection] = useState<boolean>(false);

  // Auto-select & lock homeroom teacher's assigned class
  useEffect(() => {
    if (classes.length === 0) return;
    if (user?.role === 'wali_kelas' && user.classId && classes.some((c) => c.id === user.classId)) {
      if (selectedClassId !== user.classId) {
        setSelectedClassId(user.classId);
      }
      return;
    }
    if (!selectedClassId) {
      const target = user?.classId && classes.some((c) => c.id === user.classId) ? user.classId : classes[0].id;
      setSelectedClassId(target);
    }
  }, [classes, user, selectedClassId]);

  const students = useMemo(
    () => allStudents.filter((s) => s.isActive && (!selectedClassId || s.classId === selectedClassId)),
    [allStudents, selectedClassId]
  );

  const classStudentIds = useMemo(() => new Set(students.map((s) => s.id)), [students]);

  const attendanceRecords = useMemo(
    () => todayAttendance.filter((a) => classStudentIds.has(a.studentId)),
    [todayAttendance, classStudentIds]
  );

  const classToiletPermits = useMemo(
    () => activePermits.filter((p) => classStudentIds.has(p.studentId)),
    [activePermits, classStudentIds]
  );

  const currentClass = classes.find((c) => c.id === selectedClassId);

  const hadirCount = attendanceRecords.filter((a) => a.status === 'Hadir').length;
  const lateCount = attendanceRecords.filter((a) => a.status === 'Terlambat').length;
  const izinCount = attendanceRecords.filter((a) => a.status === 'Izin').length;
  const sakitCount = attendanceRecords.filter((a) => a.status === 'Sakit').length;
  const alpaCount = attendanceRecords.filter((a) => a.status === 'Alpa').length;

  const handleExportExcel = () => {
    const rows = students.map((std, idx) => {
      const att = attendanceRecords.find((a) => a.studentId === std.id);
      return {
        No: idx + 1,
        NIS: std.nis,
        NISN: std.nisn || '-',
        'Nama Siswa': std.name,
        'Jenis Kelamin': std.gender === 'L' ? 'Laki-laki' : 'Perempuan',
        Kelas: currentClass?.name || '',
        'Status Kehadiran': att ? att.status : 'Belum Presensi',
        'Jam Masuk': att?.timeIn || '-',
        Metode: att?.method || '-',
        Keterangan: att?.notes || '-',
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Presensi_Kelas');
    XLSX.writeFile(
      workbook,
      `Rekap_Presensi_${(currentClass?.name || 'Kelas').replace(/\s+/g, '_')}_${serverDate || getWibTodayStr()}.xlsx`
    );
  };

  const handleSaveCorrection = async () => {
    if (!correctionTarget) return;
    setIsSubmittingCorrection(true);
    setCorrectionError(null);

    try {
      const res = await postWithOfflineFallback('manualStudentAttendance', {
        studentId: correctionTarget.studentId,
        status: correctionStatus,
        notes: `Koreksi: ${correctionReason}`,
        date: correctionTarget.date,
        sessionId: correctionTarget.sessionId || activeStudentSession?.id || undefined,
        expectedUpdatedAt: correctionTarget.diubah_pada || correctionTarget.updatedAt || undefined,
      });

      if (res.success) {
        setCorrectionTarget(null);
        setCorrectionReason('');
        await notifyFaceDatabaseChanged();
      } else {
        setCorrectionError(res.error || 'Gagal menyimpan koreksi.');
      }
    } catch (e: any) {
      setCorrectionError(e?.message || 'Terjadi konflik atau gagal menyimpan koreksi.');
    } finally {
      setIsSubmittingCorrection(false);
    }
  };

  const filteredStudents = students.filter(
    (s) => s.name.toLowerCase().includes(searchQuery.toLowerCase()) || s.nis.includes(searchQuery)
  );

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400 mb-1">
            <Users className="w-4 h-4" />
            <span>Ruang Kerja Wali Kelas</span>
          </div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
            Kelas {currentClass?.name || '...'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Wali Kelas: <strong>{user?.name || currentClass?.homeRoomTeacherName || '-'}</strong>
            {user?.nip ? ` (NIP: ${user.nip})` : ''} • Total {students.length} Siswa
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {(user?.role === 'admin' || user?.role === 'kepala_sekolah') && classes.length > 0 && (
            <select
              value={selectedClassId}
              onChange={(e) => setSelectedClassId(e.target.value)}
              className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            >
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  Kelas {c.name}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={handleExportExcel}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 rounded-xl border border-emerald-200 dark:border-emerald-800 transition"
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Ekspor Excel</span>
          </button>

          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 rounded-xl transition"
          >
            <Printer className="w-4 h-4" />
            <span>Cetak PDF</span>
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Hadir</span>
          <div className="text-2xl font-black text-emerald-600 mt-1">{hadirCount}</div>
          <span className="text-[11px] text-slate-400">Tepat Waktu</span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Terlambat</span>
          <div className="text-2xl font-black text-amber-500 mt-1">{lateCount}</div>
          <span className="text-[11px] text-slate-400">
            &gt; {activeStudentSession?.lateCutoffTime || settings?.lateCutoffTime} WIB
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Izin</span>
          <div className="text-2xl font-black text-blue-600 mt-1">{izinCount}</div>
          <span className="text-[11px] text-slate-400">Dengan surat/konfirmasi</span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Sakit</span>
          <div className="text-2xl font-black text-purple-600 mt-1">{sakitCount}</div>
          <span className="text-[11px] text-slate-400">Surat keterangan</span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Alpa</span>
          <div className="text-2xl font-black text-red-600 mt-1">{alpaCount}</div>
          <span className="text-[11px] text-slate-400">Tanpa keterangan</span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Di Toilet</span>
          <div className="text-2xl font-black text-amber-600 mt-1">{classToiletPermits.length}</div>
          <span className="text-[11px] text-slate-400">Aktif saat ini</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
        {(['today', 'weekly', 'monthly', 'compare'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setReportType(tab)}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
              reportType === tab
                ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/20'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {tab === 'today' && 'Rekap Harian'}
            {tab === 'weekly' && 'Rekap Pekanan'}
            {tab === 'monthly' && 'Rekap Bulanan'}
            {tab === 'compare' && 'Rekap Antar Bulan'}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama atau NIS siswa..."
              className="w-full pl-10 pr-4 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            />
          </div>

          <div className="text-xs text-slate-500">
            Klik nama siswa untuk melihat <strong>Grafik Tren & Persentase</strong>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                <th className="py-3 px-3">NIS</th>
                <th className="py-3 px-3">Nama Siswa</th>
                <th className="py-3 px-3">L/P</th>
                <th className="py-3 px-3">Status Hari Ini</th>
                <th className="py-3 px-3">Jam Masuk</th>
                <th className="py-3 px-3">Metode</th>
                <th className="py-3 px-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredStudents.map((student) => {
                const att = attendanceRecords.find((a) => a.studentId === student.id);
                return (
                  <tr key={student.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition group">
                    <td className="py-3.5 px-3 font-mono font-medium text-slate-500">{student.nis}</td>
                    <td className="py-3.5 px-3">
                      <button
                        onClick={() => setDetailStudent(student)}
                        className="font-bold text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1.5 transition text-left"
                      >
                        <span>{student.name}</span>
                        <BarChart3 className="w-3.5 h-3.5 text-blue-500 opacity-0 group-hover:opacity-100 transition" />
                      </button>
                    </td>
                    <td className="py-3.5 px-3 font-semibold text-slate-500">{student.gender}</td>
                    <td className="py-3.5 px-3">
                      {att ? (
                        <span
                          className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-bold ${
                            att.status === 'Hadir'
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                              : att.status === 'Terlambat'
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                              : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                          }`}
                        >
                          {att.status}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">Belum Ada</span>
                      )}
                    </td>
                    <td className="py-3.5 px-3 font-mono text-slate-500">{att?.timeIn || '-'}</td>
                    <td className="py-3.5 px-3 text-slate-500">{att?.method || '-'}</td>
                    <td className="py-3.5 px-3 text-right">
                      {att ? (
                        <button
                          onClick={() => {
                            setCorrectionTarget(att);
                            setCorrectionStatus(att.status);
                            setCorrectionReason('');
                            setCorrectionError(null);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-blue-600 bg-blue-50 dark:bg-blue-950/60 dark:text-blue-400 rounded-lg hover:bg-blue-100 transition"
                        >
                          Koreksi
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setCorrectionTarget({
                              id: '',
                              studentId: student.id,
                              date: serverDate || getWibTodayStr(),
                              timeIn: '07:00:00',
                              status: 'Izin',
                              method: 'MANUAL',
                              sessionId: activeStudentSession?.id,
                              sessionName: activeStudentSession?.name,
                              createdAt: '',
                              updatedAt: '',
                              updatedBy: '',
                            });
                            setCorrectionStatus('Izin');
                            setCorrectionReason('');
                            setCorrectionError(null);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 rounded-lg transition"
                        >
                          Input Manual
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {detailStudent && (
        <StudentDetailModal
          student={detailStudent}
          className={currentClass?.name || ''}
          onClose={() => setDetailStudent(null)}
        />
      )}

      {correctionTarget && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Koreksi Status Presensi</h3>
            <p className="text-xs text-slate-500 mb-4">Perubahan status akan dicatat ke sheet Log Google Sheets.</p>

            {correctionError && (
              <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                {correctionError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Status Baru
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa'] as const).map((st) => (
                    <button
                      type="button"
                      key={st}
                      onClick={() => setCorrectionStatus(st)}
                      className={`py-2 text-xs font-bold rounded-xl border transition ${
                        correctionStatus === st
                          ? 'bg-blue-600 text-white border-blue-600'
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
                  Alasan Koreksi (Wajib untuk Audit)
                </label>
                <textarea
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  placeholder="Contoh: Siswa terlambat karena mengurus administrasi di ruang TU"
                  rows={3}
                  className="w-full p-3 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setCorrectionTarget(null)}
                  className="px-4 py-2 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveCorrection()}
                  disabled={isSubmittingCorrection || !correctionReason.trim()}
                  className="px-5 py-2 text-xs font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow disabled:opacity-50"
                >
                  {isSubmittingCorrection ? 'Menyimpan...' : 'Simpan Koreksi'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Detail Modal with real stats per student
const StudentDetailModal: React.FC<{
  student: Student;
  className: string;
  onClose: () => void;
}> = ({ student, className, onClose }) => {
  const [history, setHistory] = useState<StudentAttendance[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const recapRes = await gasGet<{
          studentSummaries: Array<{ studentId: string; recentRecords: StudentAttendance[] }>;
        }>('studentRecap', { classId: student.classId });

        if (recapRes.success && Array.isArray(recapRes.studentSummaries)) {
          const summary = recapRes.studentSummaries.find((s) => s.studentId === student.id);
          if (summary) setHistory(summary.recentRecords || []);
        }
      } catch {
        // Fallback to empty history if offline
      } finally {
        setIsLoading(false);
      }
    })();
  }, [student]);

  const hadirCount = history.filter((h) => h.status === 'Hadir').length;
  const lateCount = history.filter((h) => h.status === 'Terlambat').length;
  const izinCount = history.filter((h) => h.status === 'Izin' || h.status === 'Sakit').length;
  const alpaCount = history.filter((h) => h.status === 'Alpa').length;
  const total = hadirCount + lateCount + izinCount + alpaCount;
  const rate = total > 0 ? Math.round(((hadirCount + lateCount) / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
              Statistik & Tren Kehadiran Siswa
            </span>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{student.name}</h2>
            <p className="text-xs text-slate-500">
              NIS: {student.nis} • Kelas: {className}
            </p>
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
          >
            Tutup
          </button>
        </div>

        {isLoading ? (
          <div className="py-10 text-center text-xs text-slate-400">Memuat riwayat kehadiran dari Google Sheets...</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900">
                <span className="text-xs text-blue-600 dark:text-blue-400 font-semibold">Persentase Hadir</span>
                <div className="text-3xl font-black text-blue-700 dark:text-blue-300 mt-1">{rate}%</div>
                <span className="text-[10px] text-blue-500">Target minimal 85%</span>
              </div>

              <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900">
                <span className="text-xs text-amber-600 dark:text-amber-400 font-semibold">Total Terlambat</span>
                <div className="text-3xl font-black text-amber-700 dark:text-amber-300 mt-1">{lateCount}x</div>
                <span className="text-[10px] text-amber-500">Tercatat di Sheet</span>
              </div>

              <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900">
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold">Tepat Waktu</span>
                <div className="text-3xl font-black text-emerald-700 dark:text-emerald-300 mt-1">{hadirCount}x</div>
                <span className="text-[10px] text-emerald-500">Tercatat di Sheet</span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                <span>Komposisi Kehadiran</span>
                <span>{total} Hari Terdata</span>
              </div>
              <div className="w-full h-4 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
                {total > 0 && (
                  <>
                    <div style={{ width: `${(hadirCount / total) * 100}%` }} className="bg-emerald-500" title="Hadir" />
                    <div style={{ width: `${(lateCount / total) * 100}%` }} className="bg-amber-500" title="Terlambat" />
                    <div style={{ width: `${(izinCount / total) * 100}%` }} className="bg-blue-500" title="Izin/Sakit" />
                    <div style={{ width: `${(alpaCount / total) * 100}%` }} className="bg-red-500" title="Alpa" />
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500 pt-1">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Hadir ({hadirCount})
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> Terlambat ({lateCount})
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500" /> Izin/Sakit ({izinCount})
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Alpa ({alpaCount})
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
