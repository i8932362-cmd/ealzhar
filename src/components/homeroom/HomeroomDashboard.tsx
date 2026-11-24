import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  Users,
  FileSpreadsheet,
  FileText,
  Printer,
  Search,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Calendar,
  CalendarDays,
  CalendarRange,
  Download,
  RefreshCw,
  CheckCircle2,
  Clock,
  ChevronDown,
  FileArchive,
  Layers,
  Loader2,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useSync } from '../../context/SyncContext.tsx';
import { Student, StudentAttendance, StudentAttendanceStatus } from '../../types/index.ts';
import { gasGet, postWithOfflineFallback, getWibTodayStr } from '../../lib/api.ts';
import { emitActionToast } from '../../lib/toast.ts';
import {
  buildDailyAttendanceIndex,
  computeMonthlyRecap,
  computeMultiMonthRecap,
  computeRecapForDates,
  DailyAttendanceIndex,
  formatIndoDate,
  formatIndoDateShort,
  formatIndoMonth,
  formatIndoMonthShort,
  getIndoDayName,
  getIndoDayShort,
  getMonthBounds,
  getWeeksInMonth,
  mergeAttendanceSources,
  shiftIsoDate,
  shiftYearMonth,
  StudentPeriodTotals,
} from '../../lib/homeroomRecap.ts';
import {
  exportBulkClassCombinedPdf,
  exportBulkClassZipPdf,
  exportClassRecapPdf,
  exportSingleStudentPdf,
  HomeroomReportMode,
  PdfSchoolMeta,
} from '../../lib/homeroomPdfExport.ts';

function statusBadgeClass(status: StudentAttendanceStatus): string {
  if (status === 'Hadir') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300';
  }
  if (status === 'Terlambat') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300';
  }
  if (status === 'Izin') {
    return 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300';
  }
  if (status === 'Sakit') {
    return 'bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300';
  }
  return 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300';
}

function statusInitialBadge(status?: StudentAttendanceStatus): { text: string; cls: string } {
  if (!status) {
    return {
      text: '-',
      cls: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
    };
  }
  if (status === 'Hadir') return { text: 'H', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300' };
  if (status === 'Terlambat') return { text: 'T', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300' };
  if (status === 'Izin') return { text: 'I', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300' };
  if (status === 'Sakit') return { text: 'S', cls: 'bg-purple-100 text-purple-700 dark:bg-purple-950/70 dark:text-purple-300' };
  return { text: 'A', cls: 'bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-300' };
}

export const HomeroomDashboard: React.FC = () => {
  const { user } = useAuth();
  const {
    classes,
    students: allStudents,
    todayAttendance,
    activePermits,
    settings,
    sessions,
    activeStudentSession,
    serverDate,
    serverVersion,
    notifyFaceDatabaseChanged,
  } = useSync();

  const todayStr = serverDate || getWibTodayStr();
  const currentMonthStr = todayStr.slice(0, 7);

  const [selectedClassId, setSelectedClassId] = useState<string>('');
  const [reportType, setReportType] = useState<HomeroomReportMode>('today');
  const [sessionFilter, setSessionFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [detailStudent, setDetailStudent] = useState<Student | null>(null);

  // Period navigation states
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthStr);
  const [selectedWeekNum, setSelectedWeekNum] = useState<number>(() => {
    const weeks = getWeeksInMonth(currentMonthStr);
    const match = weeks.find((w) => todayStr >= w.startDate && todayStr <= w.endDate);
    return match?.weekNumber || 1;
  });
  const [compareYear, setCompareYear] = useState<number>(() => Number(currentMonthStr.slice(0, 4)) || 2026);
  const [selectedCompareMonths, setSelectedCompareMonths] = useState<string[]>(() => {
    const prevMonth = shiftYearMonth(currentMonthStr, -1);
    return [prevMonth, currentMonthStr];
  });

  // Historical attendance state from Google Sheets (studentRecap)
  const [historicalRecords, setHistoricalRecords] = useState<StudentAttendance[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // PDF Menu & ZIP Progress
  const [showPdfMenu, setShowPdfMenu] = useState<boolean>(false);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);
  const [zipProgress, setZipProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const pdfMenuRef = useRef<HTMLDivElement | null>(null);

  // Correction Modal
  const [correctionTarget, setCorrectionTarget] = useState<StudentAttendance | null>(null);
  const [correctionStatus, setCorrectionStatus] = useState<StudentAttendanceStatus>('Hadir');
  const [correctionReason, setCorrectionReason] = useState<string>('');
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [isSubmittingCorrection, setIsSubmittingCorrection] = useState<boolean>(false);

  // Close PDF dropdown on outside click
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (pdfMenuRef.current && !pdfMenuRef.current.contains(e.target as Node)) {
        setShowPdfMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

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

  const studentSessions = useMemo(
    () => sessions.filter((s) => s.targetType === 'student'),
    [sessions]
  );

  const students = useMemo(
    () =>
      allStudents
        .filter((s) => s.isActive && (!selectedClassId || s.classId === selectedClassId))
        .sort((a, b) => a.name.localeCompare(b.name, 'id')),
    [allStudents, selectedClassId]
  );

  const classStudentIds = useMemo(() => new Set(students.map((s) => s.id)), [students]);
  const currentClass = classes.find((c) => c.id === selectedClassId);

  // Load full class attendance history from Google Sheets so past/future dates, weeks, months & inter-month totals work accurately
  const loadClassHistory = useCallback(
    async (silent = false) => {
      if (!selectedClassId) return;
      if (!silent) {
        setIsLoadingHistory(true);
      }
      setHistoryError(null);
      try {
        const res = await gasGet<{
          records?: StudentAttendance[];
          studentSummaries?: Array<{ studentId: string; recentRecords: StudentAttendance[] }>;
        }>('studentRecap', { classId: selectedClassId });

        if (res.success) {
          let recs: StudentAttendance[] = [];
          if (Array.isArray(res.records)) {
            recs = res.records;
          } else if (Array.isArray(res.studentSummaries)) {
            recs = res.studentSummaries.flatMap((s) => s.recentRecords || []);
          }
          setHistoricalRecords(recs);
        } else if (!silent) {
          setHistoryError(res.error || 'Gagal memuat riwayat presensi kelas.');
        }
      } catch (err: any) {
        if (!silent) {
          setHistoryError(err?.message || 'Tidak dapat memuat riwayat presensi dari Google Sheets.');
        }
      } finally {
        if (!silent) {
          setIsLoadingHistory(false);
        }
      }
    },
    [selectedClassId]
  );

  useEffect(() => {
    if (!selectedClassId) return;
    void loadClassHistory(false);
  }, [selectedClassId, loadClassHistory]);

  // Refresh class history cleanly whenever serverVersion advances (after scan or correction)
  const prevVersionRef = useRef<number>(serverVersion);
  useEffect(() => {
    if (serverVersion !== prevVersionRef.current) {
      prevVersionRef.current = serverVersion;
      if (selectedClassId) {
        void loadClassHistory(true);
      }
    }
  }, [serverVersion, selectedClassId, loadClassHistory]);

  // Merge Google Sheets historical records with live todayAttendance
  const mergedAttendanceRecords = useMemo(
    () => mergeAttendanceSources(historicalRecords, todayAttendance),
    [historicalRecords, todayAttendance]
  );

  // Single Source of Truth Daily Index (every student has <= 1 resolved daily record per date)
  const dailyIndex = useMemo(
    () => buildDailyAttendanceIndex(mergedAttendanceRecords, classStudentIds, sessionFilter),
    [mergedAttendanceRecords, classStudentIds, sessionFilter]
  );

  // Weeks within selectedMonth for Weekly Tab
  const weeksInSelectedMonth = useMemo(() => getWeeksInMonth(selectedMonth), [selectedMonth]);

  useEffect(() => {
    if (weeksInSelectedMonth.length === 0) return;
    if (!weeksInSelectedMonth.some((w) => w.weekNumber === selectedWeekNum)) {
      setSelectedWeekNum(1);
    }
  }, [weeksInSelectedMonth, selectedWeekNum]);

  const activeWeekSlot = useMemo(
    () => weeksInSelectedMonth.find((w) => w.weekNumber === selectedWeekNum) || weeksInSelectedMonth[0],
    [weeksInSelectedMonth, selectedWeekNum]
  );

  // Per-week summaries within selectedMonth (proving Antar Pekan in 1 month sums directly from Daily)
  const weekSlotSummaries = useMemo(
    () =>
      weeksInSelectedMonth.map((slot) => ({
        slot,
        recap: computeRecapForDates(students, dailyIndex, slot.dates),
      })),
    [weeksInSelectedMonth, students, dailyIndex]
  );

  // Active computations per tab — ALL strictly anchored to dailyIndex
  const dailyRecap = useMemo(
    () => computeRecapForDates(students, dailyIndex, [selectedDate]),
    [students, dailyIndex, selectedDate]
  );

  const weeklyRecap = useMemo(
    () => computeRecapForDates(students, dailyIndex, activeWeekSlot?.dates || []),
    [students, dailyIndex, activeWeekSlot]
  );

  const monthlyRecap = useMemo(
    () => computeMonthlyRecap(students, dailyIndex, selectedMonth),
    [students, dailyIndex, selectedMonth]
  );

  const monthlyDates = useMemo(() => getMonthBounds(selectedMonth).dates, [selectedMonth]);

  const multiMonthRecap = useMemo(
    () => computeMultiMonthRecap(students, dailyIndex, selectedCompareMonths),
    [students, dailyIndex, selectedCompareMonths]
  );

  const compareAllDates = useMemo(
    () =>
      Array.from(new Set(selectedCompareMonths))
        .sort()
        .flatMap((ym) => getMonthBounds(ym).dates),
    [selectedCompareMonths]
  );

  // Active mode summary for KPIs & Exports
  const activePeriodData = useMemo(() => {
    if (reportType === 'today') {
      const dateMap = dailyIndex.byDate.get(selectedDate);
      let h = 0;
      let t = 0;
      let iz = 0;
      let sk = 0;
      let al = 0;
      students.forEach((s) => {
        const entry = dateMap?.get(s.id);
        if (!entry) return;
        if (entry.status === 'Hadir') h++;
        else if (entry.status === 'Terlambat') t++;
        else if (entry.status === 'Izin') iz++;
        else if (entry.status === 'Sakit') sk++;
        else if (entry.status === 'Alpa') al++;
      });
      const recCount = h + t + iz + sk + al;
      return {
        totals: {
          hadir: h,
          terlambat: t,
          izin: iz,
          sakit: sk,
          alpa: al,
          totalRecorded: recCount,
          activeDaysCount: recCount > 0 ? 1 : 0,
          attendanceRate: students.length > 0 ? Math.round(((h + t) / students.length) * 100) : 0,
        },
        studentRows: dailyRecap.studentRows,
        dailyBreakdown: dailyRecap.dailyBreakdown,
        activeDates: [selectedDate],
        selectedMonths: [],
      };
    }

    if (reportType === 'weekly') {
      return {
        totals: weeklyRecap.totals,
        studentRows: weeklyRecap.studentRows,
        dailyBreakdown: weeklyRecap.dailyBreakdown,
        activeDates: weeklyRecap.activeDatesInPeriod,
        selectedMonths: [],
      };
    }

    if (reportType === 'monthly') {
      const monthRows = Array.from(monthlyRecap.studentTotalsMap.values());
      return {
        totals: monthlyRecap.totals,
        studentRows: monthRows,
        dailyBreakdown: monthlyRecap.dailyBreakdown,
        activeDates: monthlyRecap.dailyBreakdown.map((d) => d.date),
        selectedMonths: [monthlyRecap],
      };
    }

    return {
      totals: multiMonthRecap.combined.totals,
      studentRows: multiMonthRecap.combined.studentRows,
      dailyBreakdown: multiMonthRecap.combined.dailyBreakdown,
      activeDates: multiMonthRecap.combined.activeDatesInPeriod,
      selectedMonths: multiMonthRecap.months,
    };
  }, [reportType, dailyIndex, selectedDate, students, dailyRecap, weeklyRecap, monthlyRecap, multiMonthRecap]);

  const classToiletPermits = useMemo(
    () => activePermits.filter((p) => classStudentIds.has(p.studentId)),
    [activePermits, classStudentIds]
  );

  // Search filtering for table display
  const filteredStudentRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return activePeriodData.studentRows;
    return activePeriodData.studentRows.filter(
      (r) =>
        r.student.name.toLowerCase().includes(q) ||
        r.student.nis.toLowerCase().includes(q) ||
        (r.student.nisn || '').toLowerCase().includes(q)
    );
  }, [activePeriodData.studentRows, searchQuery]);

  // Period metadata for PDF & Excel headers
  const activeSessionLabel = useMemo(() => {
    if (sessionFilter === 'ALL') return 'Semua Sesi';
    return studentSessions.find((s) => s.id === sessionFilter)?.name || 'Sesi Terpilih';
  }, [sessionFilter, studentSessions]);

  const pdfMeta: PdfSchoolMeta = useMemo(() => {
    let periodTitle = '';
    let periodSubtitle = '';
    let fileSlug = '';

    if (reportType === 'today') {
      periodTitle = `Rekap Harian — ${formatIndoDate(selectedDate)}`;
      periodSubtitle = getIndoDayName(selectedDate);
      fileSlug = `Harian_${selectedDate}`;
    } else if (reportType === 'weekly') {
      periodTitle = `Rekap Pekanan — ${activeWeekSlot?.label || 'Pekan'} (${formatIndoMonth(selectedMonth)})`;
      periodSubtitle = activeWeekSlot ? `${formatIndoDateShort(activeWeekSlot.startDate)} s/d ${formatIndoDateShort(activeWeekSlot.endDate)}` : selectedMonth;
      fileSlug = `Pekanan_${selectedMonth}_P${activeWeekSlot?.weekNumber || 1}`;
    } else if (reportType === 'monthly') {
      periodTitle = `Rekap Bulanan — ${formatIndoMonth(selectedMonth)}`;
      periodSubtitle = `Total ${activePeriodData.totals.activeDaysCount} Hari Presensi Harian`;
      fileSlug = `Bulanan_${selectedMonth}`;
    } else {
      const sortedM = [...selectedCompareMonths].sort();
      periodTitle = `Rekap Antar Bulan (${sortedM.length} Bulan Terpilih)`;
      periodSubtitle = sortedM.map((m) => formatIndoMonthShort(m)).join(', ') || '-';
      fileSlug = `Antar_Bulan_${sortedM.join('_') || currentMonthStr}`;
    }

    return {
      schoolName: settings?.schoolName || 'Yayasan Mambaul Ulum',
      schoolAddress: settings?.foundationAddress,
      academicYear: settings?.academicYear || '2026/2027',
      classInfo: currentClass,
      homeroomTeacherName: user?.name || currentClass?.homeRoomTeacherName || 'Wali Kelas',
      homeroomTeacherNip: user?.nip,
      periodTitle,
      periodSubtitle,
      fileSlug,
      sessionLabel: activeSessionLabel,
    };
  }, [reportType, selectedDate, selectedMonth, activeWeekSlot, activePeriodData.totals.activeDaysCount, selectedCompareMonths, currentMonthStr, settings, currentClass, user, activeSessionLabel]);

  // Excel Export matching active tab
  const handleExportExcel = () => {
    const wb = XLSX.utils.book_new();
    if (reportType === 'today') {
      const dateMap = dailyIndex.byDate.get(selectedDate);
      const rows = activePeriodData.studentRows.map((row, idx) => {
        const entry = dateMap?.get(row.student.id);
        const rec = entry?.primaryRecord;
        return {
          No: idx + 1,
          Tanggal: selectedDate,
          NIS: row.student.nis,
          NISN: row.student.nisn || '-',
          'Nama Siswa': row.student.name,
          'L/P': row.student.gender,
          Kelas: currentClass?.name || '',
          Status: entry ? entry.status : 'Belum Ada',
          'Jam Masuk': rec?.timeIn || '-',
          Sesi: entry?.sessionRecords.map((s) => s.sessionName).filter(Boolean).join(', ') || '-',
          Metode: rec?.method || '-',
          Keterangan: rec?.notes || '-',
        };
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Rekap_Harian');
    } else {
      const rows = activePeriodData.studentRows.map((row, idx) => ({
        No: idx + 1,
        NIS: row.student.nis,
        NISN: row.student.nisn || '-',
        'Nama Siswa': row.student.name,
        'L/P': row.student.gender,
        Kelas: currentClass?.name || '',
        Hadir: row.hadir,
        Terlambat: row.terlambat,
        Izin: row.izin,
        Sakit: row.sakit,
        Alpa: row.alpa,
        'Total Tercatat': row.totalRecorded,
        'Hari Aktif': row.effectiveDays,
        'Persentase Hadir (%)': row.attendanceRate,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Rekap_Siswa');

      if (activePeriodData.dailyBreakdown.length > 0) {
        const dailyRows = activePeriodData.dailyBreakdown.map((d, idx) => ({
          No: idx + 1,
          Tanggal: d.date,
          Hari: d.dayName,
          Hadir: d.hadir,
          Terlambat: d.terlambat,
          Izin: d.izin,
          Sakit: d.sakit,
          Alpa: d.alpa,
          'Belum Ada': d.belumAda,
          'Total Tercatat': d.totalRecorded,
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dailyRows), 'Rincian_Per_Hari');
      }
    }

    const safeCls = (currentClass?.name || 'Kelas').replace(/\s+/g, '_');
    XLSX.writeFile(wb, `Rekap_Presensi_${safeCls}_${pdfMeta.fileSlug}.xlsx`);
    emitActionToast({ type: 'saved', title: 'Ekspor Excel', message: 'File Excel rekap presensi berhasil diunduh.' });
  };

  // Single student PDF download
  const handleDownloadStudentPdf = (studentRow: StudentPeriodTotals) => {
    exportSingleStudentPdf({
      studentRow,
      meta: pdfMeta,
      mode: reportType,
      selectedDate,
      activeDates: activePeriodData.activeDates,
      dailyIndex,
      selectedMonths: activePeriodData.selectedMonths,
    });
    emitActionToast({
      type: 'saved',
      title: 'PDF Siswa Diunduh',
      message: `Rekap PDF ${studentRow.student.name} berhasil dibuat.`,
    });
  };

  // Bulk Class PDF actions
  const handleDownloadClassSummaryPdf = () => {
    setShowPdfMenu(false);
    exportClassRecapPdf({
      meta: pdfMeta,
      mode: reportType,
      selectedDate,
      totals: activePeriodData.totals,
      studentRows: activePeriodData.studentRows,
      dailyIndex,
      dailyBreakdown: activePeriodData.dailyBreakdown,
      selectedMonths: activePeriodData.selectedMonths,
    });
    emitActionToast({
      type: 'saved',
      title: 'PDF Kelas Diunduh',
      message: `Rekap tabel Kelas ${currentClass?.name || ''} berhasil diunduh.`,
    });
  };

  const handleDownloadClassCombinedPdf = () => {
    setShowPdfMenu(false);
    exportBulkClassCombinedPdf({
      meta: pdfMeta,
      mode: reportType,
      selectedDate,
      activeDates: activePeriodData.activeDates,
      totals: activePeriodData.totals,
      studentRows: activePeriodData.studentRows,
      dailyIndex,
      dailyBreakdown: activePeriodData.dailyBreakdown,
      selectedMonths: activePeriodData.selectedMonths,
    });
    emitActionToast({
      type: 'saved',
      title: 'PDF Masal Satu Kelas',
      message: `PDF lengkap (rekap kelas + ${activePeriodData.studentRows.length} siswa) berhasil diunduh.`,
    });
  };

  const handleDownloadClassZipPdf = async () => {
    setShowPdfMenu(false);
    if (isExportingZip || activePeriodData.studentRows.length === 0) return;
    setIsExportingZip(true);
    setZipProgress({ current: 0, total: activePeriodData.studentRows.length, label: 'Menyiapkan PDF...' });
    try {
      await exportBulkClassZipPdf({
        meta: pdfMeta,
        mode: reportType,
        selectedDate,
        activeDates: activePeriodData.activeDates,
        totals: activePeriodData.totals,
        studentRows: activePeriodData.studentRows,
        dailyIndex,
        dailyBreakdown: activePeriodData.dailyBreakdown,
        selectedMonths: activePeriodData.selectedMonths,
        onProgress: (current, total, label) => setZipProgress({ current, total, label }),
      });
      emitActionToast({
        type: 'saved',
        title: 'ZIP PDF Selesai',
        message: `${activePeriodData.studentRows.length} PDF siswa + rekap kelas dalam ZIP berhasil diunduh.`,
      });
    } catch (err: any) {
      emitActionToast({
        type: 'error',
        title: 'Gagal Membuat ZIP PDF',
        message: err?.message || 'Terjadi kesalahan saat membuat arsip PDF.',
      });
    } finally {
      setIsExportingZip(false);
      setZipProgress(null);
    }
  };

  // Save Correction / Manual Entry for any chosen date
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
        sessionId: correctionTarget.sessionId || (sessionFilter !== 'ALL' ? sessionFilter : activeStudentSession?.id) || undefined,
        expectedUpdatedAt: correctionTarget.diubah_pada || correctionTarget.updatedAt || undefined,
      });

      if (res.success) {
        setCorrectionTarget(null);
        setCorrectionReason('');
        await notifyFaceDatabaseChanged();
        await loadClassHistory(true);
        emitActionToast({ type: 'saved', message: res.message || 'Status presensi berhasil diperbarui.' });
      } else {
        setCorrectionError(res.error || 'Gagal menyimpan koreksi.');
      }
    } catch (e: any) {
      setCorrectionError(e?.message || 'Terjadi konflik atau gagal menyimpan koreksi.');
    } finally {
      setIsSubmittingCorrection(false);
    }
  };

  // Multi-month toggle helper
  const toggleCompareMonth = (ym: string) => {
    setSelectedCompareMonths((prev) => {
      if (prev.includes(ym)) {
        if (prev.length <= 1) return prev; // Keep at least 1 month selected
        return prev.filter((item) => item !== ym);
      }
      return [...prev, ym].sort();
    });
  };

  // 3-day navigation slots for Rekap Harian (Sebelum | Dipilih | Sesudah)
  const prevDateStr = shiftIsoDate(selectedDate, -1);
  const nextDateStr = shiftIsoDate(selectedDate, 1);

  const summarizeDaySlot = (dateStr: string) => {
    const dateMap = dailyIndex.byDate.get(dateStr);
    let hadir = 0;
    let telat = 0;
    let izinSakit = 0;
    let alpa = 0;
    students.forEach((s) => {
      const st = dateMap?.get(s.id)?.status;
      if (st === 'Hadir') hadir++;
      else if (st === 'Terlambat') telat++;
      else if (st === 'Izin' || st === 'Sakit') izinSakit++;
      else if (st === 'Alpa') alpa++;
    });
    return { hadir, telat, izinSakit, alpa, total: hadir + telat + izinSakit + alpa };
  };

  const detailStudentRow = useMemo(
    () => (detailStudent ? activePeriodData.studentRows.find((r) => r.student.id === detailStudent.id) || null : null),
    [detailStudent, activePeriodData.studentRows]
  );

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header Card */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
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
            {user?.nip ? ` (NIP: ${user.nip})` : ''} • Total {students.length} Siswa • Acuan Data: Rekap Harian
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {(user?.role === 'admin' || user?.role === 'kepala_sekolah') && classes.length > 0 && (
            <select
              value={selectedClassId}
              onChange={(e) => setSelectedClassId(e.target.value)}
              className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100"
            >
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  Kelas {c.name}
                </option>
              ))}
            </select>
          )}

          {studentSessions.length > 0 && (
            <select
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
              className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100"
              title="Filter Sesi Presensi"
            >
              <option value="ALL">Semua Sesi</option>
              {studentSessions.map((ses) => (
                <option key={ses.id} value={ses.id}>
                  {ses.name}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => void loadClassHistory(false)}
            disabled={isLoadingHistory}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 rounded-xl transition disabled:opacity-60"
            title="Sinkronkan ulang seluruh riwayat presensi dari Google Sheets"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingHistory ? 'animate-spin text-blue-600' : ''}`} />
            <span className="hidden sm:inline">Muat Ulang</span>
          </button>

          <button
            type="button"
            onClick={handleExportExcel}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 rounded-xl border border-emerald-200 dark:border-emerald-800 transition"
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Excel</span>
          </button>

          {/* Unduh PDF Satu Kelas (Dropdown: Rekap Kelas / Gabungan Semua Siswa / ZIP Per Siswa) */}
          <div className="relative" ref={pdfMenuRef}>
            <button
              type="button"
              onClick={() => setShowPdfMenu((v) => !v)}
              disabled={isExportingZip || students.length === 0}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-sm shadow-blue-500/20 disabled:opacity-50 transition"
            >
              {isExportingZip ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
              <span>Unduh PDF Kelas</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {showPdfMenu && (
              <div className="absolute right-0 mt-2 w-72 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-2 z-40 space-y-1">
                <button
                  type="button"
                  onClick={handleDownloadClassSummaryPdf}
                  className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-start gap-2.5"
                >
                  <FileText className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      PDF Rekap Satu Kelas
                    </div>
                    <div className="text-[10px] text-slate-500">
                      Tabel rekap seluruh siswa sekelas + rincian harian
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={handleDownloadClassCombinedPdf}
                  className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-start gap-2.5"
                >
                  <Layers className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      PDF Masal Semua Siswa (1 File)
                    </div>
                    <div className="text-[10px] text-slate-500">
                      Rekap kelas + rincian 1 halaman penuh per siswa
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => void handleDownloadClassZipPdf()}
                  className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-start gap-2.5"
                >
                  <FileArchive className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      ZIP PDF Per Siswa Satu Kelas
                    </div>
                    <div className="text-[10px] text-slate-500">
                      Arsip .ZIP berisi file PDF terpisah tiap siswa
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 rounded-xl transition print:hidden"
            title="Cetak Layar"
          >
            <Printer className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Progress / Status alerts */}
      {historyError && (
        <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2">
          <span>{historyError}</span>
          <button
            type="button"
            onClick={() => void loadClassHistory(false)}
            className="font-bold underline"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {isExportingZip && zipProgress && (
        <div className="p-4 rounded-2xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-blue-900 dark:text-blue-100">
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
              <span>Membuat PDF Masal: {zipProgress.label}</span>
            </span>
            <span>
              {zipProgress.current} / {zipProgress.total} Siswa
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-blue-200 dark:bg-blue-900 overflow-hidden">
            <div
              className="h-2 bg-blue-600 transition-all"
              style={{ width: `${zipProgress.total > 0 ? (zipProgress.current / zipProgress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Summary KPI Cards reflecting current active mode */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Hadir</span>
          <div className="text-2xl font-black text-emerald-600 mt-1">{activePeriodData.totals.hadir}</div>
          <span className="text-[11px] text-slate-400">
            {reportType === 'today' ? formatIndoDateShort(selectedDate) : `${activePeriodData.totals.activeDaysCount} hari aktif`}
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Terlambat</span>
          <div className="text-2xl font-black text-amber-500 mt-1">{activePeriodData.totals.terlambat}</div>
          <span className="text-[11px] text-slate-400">
            &gt; {activeStudentSession?.lateCutoffTime || settings?.lateCutoffTime || '07:15'} WIB
          </span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Izin</span>
          <div className="text-2xl font-black text-blue-600 mt-1">{activePeriodData.totals.izin}</div>
          <span className="text-[11px] text-slate-400">Dengan surat/konfirmasi</span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Sakit</span>
          <div className="text-2xl font-black text-purple-600 mt-1">{activePeriodData.totals.sakit}</div>
          <span className="text-[11px] text-slate-400">Surat keterangan</span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Alpa</span>
          <div className="text-2xl font-black text-red-600 mt-1">{activePeriodData.totals.alpa}</div>
          <span className="text-[11px] text-slate-400">Tanpa keterangan</span>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Di Toilet (Live)</span>
          <div className="text-2xl font-black text-amber-600 mt-1">{classToiletPermits.length}</div>
          <span className="text-[11px] text-slate-400">Aktif saat ini</span>
        </div>
      </div>

      {/* Mode Switcher Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { id: 'today', label: 'Rekap Harian', icon: Calendar },
              { id: 'weekly', label: 'Antar Pekan (1 Bulan)', icon: CalendarDays },
              { id: 'monthly', label: 'Rekap Bulanan', icon: CalendarRange },
              { id: 'compare', label: 'Rekap Antar Bulanan', icon: BarChart3 },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setReportType(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition ${
                  reportType === tab.id
                    ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/20'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {isLoadingHistory && (
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-600 dark:text-blue-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Memuat data harian dari Sheets...</span>
          </div>
        )}
      </div>

      {/* ============================================================
          PANEL KONTROL PERIODE SESUAI TAB AKTIF
         ============================================================ */}
      {reportType === 'today' && (
        <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Cek Presensi Harian — {getIndoDayName(selectedDate)}, {formatIndoDate(selectedDate)}
              </h3>
              <p className="text-[11px] text-slate-500">
                Pilih tanggal sebelumnya, hari ini, atau sesudahnya. Data harian ini menjadi acuan rekap pekanan, bulanan, dan antar bulanan.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedDate((prev) => shiftIsoDate(prev, -1))}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Sebelum</span>
              </button>

              <input
                type="date"
                value={selectedDate}
                onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
              />

              <button
                type="button"
                onClick={() => setSelectedDate((prev) => shiftIsoDate(prev, 1))}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition"
              >
                <span>Sesudah</span>
                <ChevronRight className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setSelectedDate(todayStr)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
                  selectedDate === todayStr
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300'
                }`}
              >
                {selectedDate === todayStr ? 'Hari Ini' : `Ke Hari Ini (${formatIndoDateShort(todayStr)})`}
              </button>
            </div>
          </div>

          {/* 3-day quick overview cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: 'Tanggal Sebelum', date: prevDateStr, active: false },
              { label: selectedDate === todayStr ? 'Hari Ini (Dipilih)' : 'Tanggal Dipilih', date: selectedDate, active: true },
              { label: 'Tanggal Sesudah', date: nextDateStr, active: false },
            ].map((slot) => {
              const s = summarizeDaySlot(slot.date);
              return (
                <button
                  key={slot.date + slot.label}
                  type="button"
                  onClick={() => setSelectedDate(slot.date)}
                  className={`p-3.5 rounded-2xl border text-left transition ${
                    slot.active
                      ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/20'
                      : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 hover:border-blue-400 text-slate-800 dark:text-slate-100'
                  }`}
                >
                  <div className={`text-[10px] font-bold uppercase ${slot.active ? 'text-blue-100' : 'text-slate-400'}`}>
                    {slot.label}
                  </div>
                  <div className="text-xs font-black mt-0.5">
                    {getIndoDayName(slot.date)}, {formatIndoDateShort(slot.date)}
                  </div>
                  <div className={`text-[11px] mt-1.5 font-semibold ${slot.active ? 'text-blue-50' : 'text-slate-600 dark:text-slate-300'}`}>
                    {s.total > 0
                      ? `H: ${s.hadir} • T: ${s.telat} • I/S: ${s.izinSakit} • A: ${s.alpa}`
                      : 'Belum ada data presensi'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {reportType === 'weekly' && (
        <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Rekap Antar Pekan — Bulan {formatIndoMonth(selectedMonth)}
              </h3>
              <p className="text-[11px] text-slate-500">
                Pilih pekan di dalam bulan {formatIndoMonth(selectedMonth)}. Angka setiap pekan dihitung dari total presensi harian pada pekan tersebut.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedMonth((prev) => shiftYearMonth(prev, -1))}
                className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                title="Bulan Sebelumnya"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
                className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => setSelectedMonth((prev) => shiftYearMonth(prev, 1))}
                className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                title="Bulan Sesudahnya"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              {selectedMonth !== currentMonthStr && (
                <button
                  type="button"
                  onClick={() => setSelectedMonth(currentMonthStr)}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300"
                >
                  Bulan Ini
                </button>
              )}
            </div>
          </div>

          {/* Week Selector Cards inside Selected Month */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {weekSlotSummaries.map(({ slot, recap }) => {
              const isSelected = activeWeekSlot?.weekNumber === slot.weekNumber;
              return (
                <button
                  key={slot.weekNumber}
                  type="button"
                  onClick={() => setSelectedWeekNum(slot.weekNumber)}
                  className={`p-3 rounded-2xl border text-left transition ${
                    isSelected
                      ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/20'
                      : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 hover:border-blue-400 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black">{slot.label}</span>
                    <span className={`text-[10px] font-bold ${isSelected ? 'text-blue-100' : 'text-slate-400'}`}>
                      {recap.totals.activeDaysCount} hr
                    </span>
                  </div>
                  <div className={`text-[11px] font-semibold mt-0.5 ${isSelected ? 'text-blue-100' : 'text-slate-500'}`}>
                    {slot.shortRange}
                  </div>
                  <div className={`text-[10px] mt-1.5 font-mono ${isSelected ? 'text-white' : 'text-slate-600 dark:text-slate-300'}`}>
                    H:{recap.totals.hadir} T:{recap.totals.terlambat} A:{recap.totals.alpa}
                  </div>
                </button>
              );
            })}
          </div>

          {activeWeekSlot && (
            <div className="p-3 rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-900 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-900 dark:text-blue-100">
              <span>
                Menampilkan <strong>{activeWeekSlot.label}</strong> ({formatIndoDateShort(activeWeekSlot.startDate)} s/d{' '}
                {formatIndoDateShort(activeWeekSlot.endDate)}) • Total{' '}
                <strong>{weeklyRecap.totals.activeDaysCount} hari</strong> presensi tercatat.
              </span>
              <span className="font-bold">Tingkat Kehadiran Pekan: {weeklyRecap.totals.attendanceRate}%</span>
            </div>
          )}
        </div>
      )}

      {reportType === 'monthly' && (
        <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Rekap Bulanan — {formatIndoMonth(selectedMonth)}
              </h3>
              <p className="text-[11px] text-slate-500">
                Hasil rekap bulanan ini merupakan <strong>total penjumlahan langsung dari seluruh rekap presensi harian</strong> selama bulan {formatIndoMonth(selectedMonth)}.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedMonth((prev) => shiftYearMonth(prev, -1))}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Bulan Lalu</span>
              </button>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => e.target.value && setSelectedMonth(e.target.value)}
                className="px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => setSelectedMonth((prev) => shiftYearMonth(prev, 1))}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                <span>Bulan Depan</span>
                <ChevronRight className="w-4 h-4" />
              </button>
              {selectedMonth !== currentMonthStr && (
                <button
                  type="button"
                  onClick={() => setSelectedMonth(currentMonthStr)}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300"
                >
                  Bulan Ini
                </button>
              )}
            </div>
          </div>

          <div className="p-3 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-900 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-900 dark:text-emerald-100">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <span>
                Total <strong>{monthlyRecap.totals.activeDaysCount} hari presensi harian</strong> terdata pada {formatIndoMonth(selectedMonth)} ({monthlyDates.length} hari kalender).
              </span>
            </span>
            <span className="font-bold">Rata-rata Kehadiran Kelas: {monthlyRecap.totals.attendanceRate}%</span>
          </div>
        </div>
      )}

      {reportType === 'compare' && (
        <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Rekap Antar Bulanan ({selectedCompareMonths.length} Bulan Dipilih)
              </h3>
              <p className="text-[11px] text-slate-500">
                Pilih satu atau beberapa bulan yang ingin digabungkan. Seluruh angka dijumlahkan langsung dari <strong>rekap presensi per hari</strong> pada bulan-bulan terpilih.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  setSelectedCompareMonths([shiftYearMonth(currentMonthStr, -1), currentMonthStr].sort())
                }
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                2 Bulan Terakhir
              </button>
              <button
                type="button"
                onClick={() =>
                  setSelectedCompareMonths(
                    [shiftYearMonth(currentMonthStr, -2), shiftYearMonth(currentMonthStr, -1), currentMonthStr].sort()
                  )
                }
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                3 Bulan Terakhir
              </button>
              <button
                type="button"
                onClick={() =>
                  setSelectedCompareMonths(['07', '08', '09', '10', '11', '12'].map((m) => `${compareYear}-${m}`))
                }
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                Jul–Des {compareYear}
              </button>
              <button
                type="button"
                onClick={() =>
                  setSelectedCompareMonths(['01', '02', '03', '04', '05', '06'].map((m) => `${compareYear}-${m}`))
                }
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                Jan–Jun {compareYear}
              </button>
            </div>
          </div>

          {/* Year Selector & 12 Month Toggles */}
          <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCompareYear((y) => y - 1)}
                  className="p-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-xs font-black text-slate-900 dark:text-white px-2">Tahun {compareYear}</span>
                <button
                  type="button"
                  onClick={() => setCompareYear((y) => y + 1)}
                  className="p-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-slate-500">Terpilih:</span>
                {selectedCompareMonths.map((ym) => (
                  <button
                    key={ym}
                    type="button"
                    onClick={() => toggleCompareMonth(ym)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-200 font-bold"
                    title="Klik untuk hapus dari pilihan"
                  >
                    <span>{formatIndoMonthShort(ym)}</span>
                    {selectedCompareMonths.length > 1 && <X className="w-3 h-3" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-1.5">
              {['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((mm) => {
                const ym = `${compareYear}-${mm}`;
                const checked = selectedCompareMonths.includes(ym);
                return (
                  <button
                    key={ym}
                    type="button"
                    onClick={() => toggleCompareMonth(ym)}
                    className={`py-2 px-1 rounded-xl text-[11px] font-bold border transition ${
                      checked
                        ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-blue-400'
                    }`}
                  >
                    {formatIndoMonthShort(ym).split(' ')[0]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Per-Selected-Month Breakdown Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {multiMonthRecap.months.map((m) => (
              <div
                key={m.monthKey}
                className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3"
              >
                <div>
                  <div className="text-xs font-black text-slate-900 dark:text-white">{m.monthLabel}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {m.totals.activeDaysCount} hari presensi harian
                  </div>
                  <div className="text-[11px] font-mono text-slate-700 dark:text-slate-200 mt-1">
                    H:{m.totals.hadir} • T:{m.totals.terlambat} • I:{m.totals.izin} • S:{m.totals.sakit} • A:{m.totals.alpa}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-black text-blue-600 dark:text-blue-400">{m.totals.attendanceRate}%</div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMonth(m.monthKey);
                      setReportType('monthly');
                    }}
                    className="text-[10px] font-bold text-blue-600 hover:underline"
                  >
                    Lihat Bulan Ini
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============================================================
          MAIN STUDENT RECAP TABLE
         ============================================================ */}
      <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama, NIS, atau NISN siswa..."
              className="w-full pl-10 pr-4 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
            />
          </div>

          <div className="text-xs text-slate-500">
            Klik nama siswa untuk <strong>Grafik & Rincian Harian</strong>, atau klik <strong>PDF</strong> di tiap baris untuk unduh per siswa.
          </div>
        </div>

        <div className="overflow-x-auto">
          {reportType === 'today' ? (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                  <th className="py-3 px-3">NIS</th>
                  <th className="py-3 px-3">Nama Siswa</th>
                  <th className="py-3 px-3">L/P</th>
                  <th className="py-3 px-3">Status ({formatIndoDateShort(selectedDate)})</th>
                  <th className="py-3 px-3">Jam Masuk</th>
                  <th className="py-3 px-3">Sesi</th>
                  <th className="py-3 px-3">Metode</th>
                  <th className="py-3 px-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredStudentRows.map((row) => {
                  const student = row.student;
                  const dailyEntry = dailyIndex.byDate.get(selectedDate)?.get(student.id);
                  const att = dailyEntry?.primaryRecord;
                  const sessionNames = dailyEntry
                    ? Array.from(new Set(dailyEntry.sessionRecords.map((r) => r.sessionName).filter(Boolean))).join(', ')
                    : '-';

                  return (
                    <tr key={student.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition group">
                      <td className="py-3.5 px-3 font-mono font-medium text-slate-500">{student.nis}</td>
                      <td className="py-3.5 px-3">
                        <button
                          type="button"
                          onClick={() => setDetailStudent(student)}
                          className="font-bold text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1.5 transition text-left"
                        >
                          <span>{student.name}</span>
                          <BarChart3 className="w-3.5 h-3.5 text-blue-500 opacity-0 group-hover:opacity-100 transition" />
                        </button>
                      </td>
                      <td className="py-3.5 px-3 font-semibold text-slate-500">{student.gender}</td>
                      <td className="py-3.5 px-3">
                        {dailyEntry ? (
                          <span
                            className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-bold ${statusBadgeClass(
                              dailyEntry.status
                            )}`}
                          >
                            {dailyEntry.status}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic">Belum Ada</span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 font-mono text-slate-500">{att?.timeIn || '-'}</td>
                      <td className="py-3.5 px-3 text-slate-500">{sessionNames || '-'}</td>
                      <td className="py-3.5 px-3 text-slate-500">{att?.method || '-'}</td>
                      <td className="py-3.5 px-3 text-right">
                        <div className="inline-flex items-center gap-1.5 justify-end">
                          {att ? (
                            <button
                              type="button"
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
                              type="button"
                              onClick={() => {
                                setCorrectionTarget({
                                  id: '',
                                  studentId: student.id,
                                  date: selectedDate,
                                  timeIn: '07:00:00',
                                  status: 'Izin',
                                  method: 'MANUAL',
                                  sessionId: sessionFilter !== 'ALL' ? sessionFilter : activeStudentSession?.id,
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

                          <button
                            type="button"
                            onClick={() => handleDownloadStudentPdf(row)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:text-rose-300 rounded-lg transition"
                            title={`Unduh PDF Rekap ${student.name}`}
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>PDF</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                  <th className="py-3 px-2.5">NIS</th>
                  <th className="py-3 px-2.5">Nama Siswa</th>
                  <th className="py-3 px-2 text-center">L/P</th>
                  {reportType === 'weekly' &&
                    activeWeekSlot?.dates.map((d) => (
                      <th key={d} className="py-2 px-1.5 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDate(d);
                            setReportType('today');
                          }}
                          className="hover:text-blue-600 transition leading-tight"
                          title={`Buka Rekap Harian ${formatIndoDate(d)}`}
                        >
                          <div className="text-[9px]">{getIndoDayShort(d)}</div>
                          <div className="text-[10px] font-bold">{d.slice(8, 10)}</div>
                        </button>
                      </th>
                    ))}
                  <th className="py-3 px-2 text-center text-emerald-600">Hadir</th>
                  <th className="py-3 px-2 text-center text-amber-600">Telat</th>
                  <th className="py-3 px-2 text-center text-blue-600">Izin</th>
                  <th className="py-3 px-2 text-center text-purple-600">Sakit</th>
                  <th className="py-3 px-2 text-center text-red-600">Alpa</th>
                  <th className="py-3 px-2 text-center">Total</th>
                  <th className="py-3 px-2 text-center">% Hadir</th>
                  <th className="py-3 px-2.5 text-right">PDF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredStudentRows.map((row) => {
                  const student = row.student;
                  return (
                    <tr key={student.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition group">
                      <td className="py-3 px-2.5 font-mono font-medium text-slate-500">{student.nis}</td>
                      <td className="py-3 px-2.5">
                        <button
                          type="button"
                          onClick={() => setDetailStudent(student)}
                          className="font-bold text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1.5 transition text-left"
                        >
                          <span>{student.name}</span>
                          <BarChart3 className="w-3.5 h-3.5 text-blue-500 opacity-0 group-hover:opacity-100 transition" />
                        </button>
                      </td>
                      <td className="py-3 px-2 text-center font-semibold text-slate-500">{student.gender}</td>

                      {reportType === 'weekly' &&
                        activeWeekSlot?.dates.map((d) => {
                          const entry = dailyIndex.byStudent.get(student.id)?.get(d);
                          const badge = statusInitialBadge(entry?.status);
                          return (
                            <td key={d} className="py-2 px-1 text-center">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedDate(d);
                                  setReportType('today');
                                }}
                                title={`${formatIndoDateShort(d)}: ${entry ? entry.status : 'Belum Ada'}`}
                                className={`w-6 h-6 rounded-md text-[10px] font-black inline-flex items-center justify-center ${badge.cls}`}
                              >
                                {badge.text}
                              </button>
                            </td>
                          );
                        })}

                      <td className="py-3 px-2 text-center font-bold text-emerald-700 dark:text-emerald-300">{row.hadir}</td>
                      <td className="py-3 px-2 text-center font-bold text-amber-600 dark:text-amber-300">{row.terlambat}</td>
                      <td className="py-3 px-2 text-center font-bold text-blue-600 dark:text-blue-300">{row.izin}</td>
                      <td className="py-3 px-2 text-center font-bold text-purple-600 dark:text-purple-300">{row.sakit}</td>
                      <td className="py-3 px-2 text-center font-bold text-red-600 dark:text-red-300">{row.alpa}</td>
                      <td className="py-3 px-2 text-center font-mono font-bold text-slate-700 dark:text-slate-200">
                        {row.totalRecorded}
                      </td>
                      <td className="py-3 px-2 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-black ${
                            row.attendanceRate >= 85
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                              : row.attendanceRate >= 65
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                              : 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                          }`}
                        >
                          {row.attendanceRate}%
                        </span>
                      </td>
                      <td className="py-3 px-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => handleDownloadStudentPdf(row)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:text-rose-300 rounded-lg transition"
                          title={`Unduh PDF Rekap ${student.name}`}
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>PDF</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {filteredStudentRows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 font-black text-slate-900 dark:text-white">
                    <td colSpan={reportType === 'weekly' ? 3 + (activeWeekSlot?.dates.length || 0) : 3} className="py-3 px-2.5">
                      TOTAL ({filteredStudentRows.length} Siswa • Acuan Rekap Per Hari)
                    </td>
                    <td className="py-3 px-2 text-center text-emerald-700 dark:text-emerald-300">
                      {filteredStudentRows.reduce((s, r) => s + r.hadir, 0)}
                    </td>
                    <td className="py-3 px-2 text-center text-amber-600 dark:text-amber-300">
                      {filteredStudentRows.reduce((s, r) => s + r.terlambat, 0)}
                    </td>
                    <td className="py-3 px-2 text-center text-blue-600 dark:text-blue-300">
                      {filteredStudentRows.reduce((s, r) => s + r.izin, 0)}
                    </td>
                    <td className="py-3 px-2 text-center text-purple-600 dark:text-purple-300">
                      {filteredStudentRows.reduce((s, r) => s + r.sakit, 0)}
                    </td>
                    <td className="py-3 px-2 text-center text-red-600 dark:text-red-300">
                      {filteredStudentRows.reduce((s, r) => s + r.alpa, 0)}
                    </td>
                    <td className="py-3 px-2 text-center font-mono">
                      {filteredStudentRows.reduce((s, r) => s + r.totalRecorded, 0)}
                    </td>
                    <td className="py-3 px-2 text-center">{activePeriodData.totals.attendanceRate}%</td>
                    <td className="py-3 px-2.5" />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>

      {/* Rincian Per Hari (Menunjukkan Penjumlahan Harian -> Pekanan / Bulanan / Antar Bulanan) */}
      {reportType !== 'today' && (
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-600" />
                <span>Rincian Per Hari Presensi (Acuan Total Periode)</span>
              </h3>
              <p className="text-[11px] text-slate-500">
                Setiap baris di bawah adalah rekap harian per tanggal. Penjumlahan semua tanggal di bawah sama persis dengan total di tabel atas. Klik tanggal untuk membuka/mengoreksi di Rekap Harian.
              </p>
            </div>
            <span className="text-xs font-bold text-slate-500">
              {activePeriodData.dailyBreakdown.length} Hari Tercatat
            </span>
          </div>

          {activePeriodData.dailyBreakdown.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">
              Belum ada catatan presensi harian pada rentang periode yang dipilih.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                  <tr>
                    <th className="py-2.5 px-3">Tanggal</th>
                    <th className="py-2.5 px-3">Hari</th>
                    <th className="py-2.5 px-2 text-center text-emerald-600">Hadir</th>
                    <th className="py-2.5 px-2 text-center text-amber-600">Telat</th>
                    <th className="py-2.5 px-2 text-center text-blue-600">Izin</th>
                    <th className="py-2.5 px-2 text-center text-purple-600">Sakit</th>
                    <th className="py-2.5 px-2 text-center text-red-600">Alpa</th>
                    <th className="py-2.5 px-2 text-center">Belum Ada</th>
                    <th className="py-2.5 px-3 text-right">Buka Harian</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {activePeriodData.dailyBreakdown.map((d) => (
                    <tr key={d.date} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 font-mono font-bold text-slate-800 dark:text-slate-200">
                        {formatIndoDateShort(d.date)}
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">{d.dayName}</td>
                      <td className="py-2.5 px-2 text-center font-bold text-emerald-600">{d.hadir}</td>
                      <td className="py-2.5 px-2 text-center font-bold text-amber-600">{d.terlambat}</td>
                      <td className="py-2.5 px-2 text-center font-bold text-blue-600">{d.izin}</td>
                      <td className="py-2.5 px-2 text-center font-bold text-purple-600">{d.sakit}</td>
                      <td className="py-2.5 px-2 text-center font-bold text-red-600">{d.alpa}</td>
                      <td className="py-2.5 px-2 text-center text-slate-400">{d.belumAda}</td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDate(d.date);
                            setReportType('today');
                          }}
                          className="text-xs font-bold text-blue-600 hover:underline"
                        >
                          Cek Tanggal →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {detailStudent && (
        <StudentDetailModal
          student={detailStudent}
          studentRow={detailStudentRow}
          className={currentClass?.name || ''}
          periodTitle={pdfMeta.periodTitle}
          dailyIndex={dailyIndex}
          candidateDates={
            reportType === 'today'
              ? [selectedDate]
              : reportType === 'weekly'
              ? activeWeekSlot?.dates || []
              : reportType === 'monthly'
              ? monthlyDates
              : compareAllDates
          }
          onDownloadPdf={() => {
            if (detailStudentRow) {
              handleDownloadStudentPdf(detailStudentRow);
            }
          }}
          onClose={() => setDetailStudent(null)}
        />
      )}

      {correctionTarget && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              Koreksi Status Presensi ({formatIndoDateShort(correctionTarget.date)})
            </h3>
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

// Detail Modal with daily-anchored stats & PDF download per student
const StudentDetailModal: React.FC<{
  student: Student;
  studentRow: StudentPeriodTotals | null;
  className: string;
  periodTitle: string;
  dailyIndex: DailyAttendanceIndex;
  candidateDates: string[];
  onDownloadPdf: () => void;
  onClose: () => void;
}> = ({ student, studentRow, className, periodTitle, dailyIndex, candidateDates, onDownloadPdf, onClose }) => {
  const entries = useMemo(() => {
    const map = dailyIndex.byStudent.get(student.id);
    if (!map) return [];
    const filterSet = new Set(candidateDates);
    return Array.from(map.values())
      .filter((e) => filterSet.size === 0 || filterSet.has(e.date))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [dailyIndex, student.id, candidateDates]);

  const hadirCount = studentRow ? studentRow.hadir : entries.filter((h) => h.status === 'Hadir').length;
  const lateCount = studentRow ? studentRow.terlambat : entries.filter((h) => h.status === 'Terlambat').length;
  const izinCount = studentRow
    ? studentRow.izin + studentRow.sakit
    : entries.filter((h) => h.status === 'Izin' || h.status === 'Sakit').length;
  const alpaCount = studentRow ? studentRow.alpa : entries.filter((h) => h.status === 'Alpa').length;
  const total = hadirCount + lateCount + izinCount + alpaCount;
  const rate = studentRow ? studentRow.attendanceRate : total > 0 ? Math.round(((hadirCount + lateCount) / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-2 sm:p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
              Statistik & Rincian Harian Siswa ({periodTitle})
            </span>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{student.name}</h2>
            <p className="text-xs text-slate-500">
              NIS: {student.nis} {student.nisn ? `• NISN: ${student.nisn}` : ''} • Kelas: {className}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDownloadPdf}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white shadow-sm transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Unduh PDF Siswa</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
            >
              Tutup
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900">
            <span className="text-xs text-blue-600 dark:text-blue-400 font-semibold">Persentase Hadir</span>
            <div className="text-3xl font-black text-blue-700 dark:text-blue-300 mt-1">{rate}%</div>
            <span className="text-[10px] text-blue-500">Target minimal 85%</span>
          </div>

          <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900">
            <span className="text-xs text-amber-600 dark:text-amber-400 font-semibold">Total Terlambat</span>
            <div className="text-3xl font-black text-amber-700 dark:text-amber-300 mt-1">{lateCount}x</div>
            <span className="text-[10px] text-amber-500">Rekap harian</span>
          </div>

          <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900">
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold">Tepat Waktu</span>
            <div className="text-3xl font-black text-emerald-700 dark:text-emerald-300 mt-1">{hadirCount}x</div>
            <span className="text-[10px] text-emerald-500">Rekap harian</span>
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

        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-700 dark:text-slate-200">
            Log Harian pada Periode Dipilih ({entries.length} hari)
          </div>
          <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-2xl divide-y divide-slate-100 dark:divide-slate-800">
            {entries.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                Belum ada catatan presensi pada periode ini.
              </div>
            ) : (
              entries.map((entry) => (
                <div key={entry.date} className="p-3 flex items-center justify-between gap-2 text-xs">
                  <div>
                    <div className="font-bold text-slate-800 dark:text-slate-100">
                      {getIndoDayName(entry.date)}, {formatIndoDateShort(entry.date)}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Jam: {entry.primaryRecord.timeIn || '-'} • {entry.primaryRecord.method || '-'}
                      {entry.primaryRecord.notes ? ` • ${entry.primaryRecord.notes}` : ''}
                    </div>
                  </div>
                  <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold ${statusBadgeClass(entry.status)}`}>
                    {entry.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
