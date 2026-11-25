import React, { useState, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  ShieldCheck,
  Users,
  GraduationCap,
  Briefcase,
  UserCheck,
  Clock,
  LayoutDashboard,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Search,
  Download,
  BookOpen,
  MapPin,
  Eye,
  X,
  ArrowRight,
  CheckCircle2,
} from 'lucide-react';
import { useSync } from '../../context/SyncContext.tsx';
import { gasGet, getWibTodayStr } from '../../lib/api.ts';
import { formatWibTime24, sortSessions } from '../../lib/sessions.ts';
import {
  mergeAttendanceSources,
  buildDailyAttendanceIndex,
  computeRecapForDates,
  getWeeksInMonth,
  computeMultiMonthRecap,
  shiftIsoDate,
  shiftYearMonth,
  formatIndoDate,
  formatIndoMonth,
  formatIndoMonthShort,
} from '../../lib/homeroomRecap.ts';
import { StudentAttendance, TeacherAttendance, Student } from '../../types/index.ts';
import { GuestBookView } from '../guest/GuestBookView.tsx';

type PrincipalSubTab = 'overview' | 'teacher_recap' | 'classes_recap' | 'guest_book';

interface TeacherRecapSummaryRow {
  teacherId: string;
  teacherName: string;
  nip: string;
  subject: string;
  email?: string;
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
  latestSessionName?: string | null;
  notes: string | null;
}

interface TeacherRecapPayload {
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
  records: TeacherAttendance[];
  dailyBreakdown: Array<{
    date: string;
    tepatWaktu: number;
    terlambat: number;
    izin: number;
    sakit: number;
    total: number;
  }>;
}

interface StudentRecapResponse {
  records: StudentAttendance[];
}

function getTeacherStatusClass(status: string): string {
  switch (status) {
    case 'Tepat Waktu':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800';
    case 'Terlambat':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800';
    case 'Izin':
      return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800';
    case 'Sakit':
      return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';
  }
}

function getStudentStatusClass(status: string): string {
  switch (status) {
    case 'Hadir':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800';
    case 'Terlambat':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800';
    case 'Izin':
      return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800';
    case 'Sakit':
      return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800';
    case 'Alpa':
      return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/60 dark:text-red-300 dark:border-red-800';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';
  }
}

export const PrincipalDashboard: React.FC = () => {
  const {
    students,
    classes,
    teachers,
    todayAttendance,
    faceTemplates,
    settings,
    sessions,
    activeStudentSession,
    guestBook,
    serverVersion,
    lastSyncedAt,
  } = useSync();

  const todayStr = getWibTodayStr();
  const [activeSubTab, setActiveSubTab] = useState<PrincipalSubTab>('overview');

  const activeStudents = useMemo(() => students.filter((s) => s.isActive !== false), [students]);
  const activeTeachers = useMemo(() => teachers.filter((t) => t.isActive !== false), [teachers]);
  const studentSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.targetType === 'student')),
    [sessions]
  );
  const teacherSessions = useMemo(
    () => sortSessions(sessions.filter((s) => s.targetType === 'teacher')),
    [sessions]
  );

  // Valid face counts (excluding orphans)
  const validStudentIdSet = useMemo(() => new Set(activeStudents.map((s) => s.id)), [activeStudents]);
  const validTeacherIdSet = useMemo(() => new Set(activeTeachers.map((t) => t.id)), [activeTeachers]);
  const enrolledStudentFaces = useMemo(
    () =>
      faceTemplates.filter(
        (f) => (!f.personType || f.personType === 'student') && validStudentIdSet.has(f.personId)
      ).length,
    [faceTemplates, validStudentIdSet]
  );
  const enrolledTeacherFaces = useMemo(
    () =>
      faceTemplates.filter((f) => f.personType === 'teacher' && validTeacherIdSet.has(f.personId)).length,
    [faceTemplates, validTeacherIdSet]
  );

  const presentStudentsToday = useMemo(
    () => todayAttendance.filter((a) => a.status === 'Hadir' || a.status === 'Terlambat').length,
    [todayAttendance]
  );
  const lateStudentsToday = useMemo(
    () => todayAttendance.filter((a) => a.status === 'Terlambat').length,
    [todayAttendance]
  );
  const guestTodayCount = useMemo(
    () => guestBook.filter((g) => g.date === todayStr).length,
    [guestBook, todayStr]
  );

  // ============================================================================
  // TEACHER ATTENDANCE & INDIVIDUAL HISTORY STATE
  // ============================================================================
  const [teacherViewMode, setTeacherViewMode] = useState<'all' | 'individual'>('all');
  const [tPeriod, setTPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [tDate, setTDate] = useState<string>(todayStr);
  const [tMonth, setTMonth] = useState<string>(todayStr.slice(0, 7));
  const [tSessionFilter, setTSessionFilter] = useState<string>('ALL');
  const [tSearch, setTSearch] = useState<string>('');
  const [tStatusFilter, setTStatusFilter] = useState<string>('ALL');
  const [teacherRecap, setTeacherRecap] = useState<TeacherRecapPayload | null>(null);
  const [loadingTeacherRecap, setLoadingTeacherRecap] = useState<boolean>(false);

  const [selectedTeacherId, setSelectedTeacherId] = useState<string>('');
  const [indDateFilter, setIndDateFilter] = useState<string>('');
  const [indMonthFilter, setIndMonthFilter] = useState<string>('');
  const [individualHistory, setIndividualHistory] = useState<TeacherAttendance[]>([]);
  const [loadingIndividual, setLoadingIndividual] = useState<boolean>(false);

  const fetchTeacherRecap = useCallback(async () => {
    setLoadingTeacherRecap(true);
    try {
      const res = await gasGet<TeacherRecapPayload>(
        'teacherRecap',
        tPeriod === 'monthly'
          ? {
              period: tPeriod,
              month: tMonth,
              sessionId: tSessionFilter !== 'ALL' ? tSessionFilter : undefined,
            }
          : {
              period: tPeriod,
              date: tDate,
              sessionId: tSessionFilter !== 'ALL' ? tSessionFilter : undefined,
            }
      );
      if (res.success && (res as any).totals) {
        setTeacherRecap(res as unknown as TeacherRecapPayload);
      }
    } catch (err) {
      console.error('Failed to fetch principal teacher recap:', err);
    } finally {
      setLoadingTeacherRecap(false);
    }
  }, [tPeriod, tDate, tMonth, tSessionFilter]);

  useEffect(() => {
    if (activeSubTab === 'teacher_recap' || activeSubTab === 'overview') {
      void fetchTeacherRecap();
    }
  }, [activeSubTab, serverVersion, fetchTeacherRecap]);

  // Keep selectedTeacherId valid if teacher gets deleted
  useEffect(() => {
    if (selectedTeacherId && !activeTeachers.some((t) => t.id === selectedTeacherId)) {
      setSelectedTeacherId('');
      setIndividualHistory([]);
    }
  }, [activeTeachers, selectedTeacherId]);

  const fetchIndividualTeacher = useCallback(
    async (tId: string) => {
      if (!tId) {
        setIndividualHistory([]);
        return;
      }
      const target = activeTeachers.find((t) => t.id === tId);
      setLoadingIndividual(true);
      try {
        const res = await gasGet<TeacherAttendance[]>('teacherHistory', {
          teacherId: tId,
          userId: tId,
          userNip: target?.nip || '',
          userEmail: target?.email || '',
          userName: target?.name || '',
          sessionId: tSessionFilter !== 'ALL' ? tSessionFilter : undefined,
        });
        if (res.success && Array.isArray(res.data)) {
          setIndividualHistory(res.data);
        }
      } catch (err) {
        console.error('Failed to fetch individual teacher history:', err);
      } finally {
        setLoadingIndividual(false);
      }
    },
    [activeTeachers, tSessionFilter]
  );

  useEffect(() => {
    if (selectedTeacherId && activeSubTab === 'teacher_recap') {
      void fetchIndividualTeacher(selectedTeacherId);
    }
  }, [selectedTeacherId, activeSubTab, serverVersion, fetchIndividualTeacher]);

  const handleStepTeacherPeriod = (delta: number) => {
    if (tPeriod === 'daily') {
      setTDate((prev) => shiftIsoDate(prev, delta));
    } else if (tPeriod === 'weekly') {
      setTDate((prev) => shiftIsoDate(prev, delta * 7));
    } else {
      setTMonth((prev) => shiftYearMonth(prev, delta));
    }
  };

  const filteredTeacherSummaries = useMemo(() => {
    if (!teacherRecap) return [];
    const activeTeacherIds = new Set(activeTeachers.map((t) => t.id));
    const q = tSearch.trim().toLowerCase();
    return teacherRecap.teacherSummaries.filter((row) => {
      if (activeTeacherIds.size > 0 && !activeTeacherIds.has(row.teacherId)) return false;
      const matchesQ =
        !q ||
        row.teacherName.toLowerCase().includes(q) ||
        row.nip.toLowerCase().includes(q) ||
        row.subject.toLowerCase().includes(q);
      if (!matchesQ) return false;
      if (tStatusFilter === 'ALL') return true;
      if (tPeriod === 'daily') return row.latestStatus === tStatusFilter;
      if (tStatusFilter === 'Tepat Waktu') return row.tepatWaktu > 0;
      if (tStatusFilter === 'Terlambat') return row.terlambat > 0;
      if (tStatusFilter === 'Izin') return row.izin > 0;
      if (tStatusFilter === 'Sakit') return row.sakit > 0;
      if (tStatusFilter === 'Belum Presensi') return row.totalRecorded === 0;
      return true;
    });
  }, [teacherRecap, activeTeachers, tSearch, tStatusFilter, tPeriod]);

  const filteredTeacherRecords = useMemo(() => {
    if (!teacherRecap) return [];
    const q = tSearch.trim().toLowerCase();
    return teacherRecap.records.filter((r) => {
      const matchesQ =
        !q ||
        String(r.teacherName || '').toLowerCase().includes(q) ||
        String(r.nip || '').toLowerCase().includes(q) ||
        String(r.subject || '').toLowerCase().includes(q);
      const matchesStatus = tStatusFilter === 'ALL' || r.status === tStatusFilter;
      return matchesQ && matchesStatus;
    });
  }, [teacherRecap, tSearch, tStatusFilter]);

  const filteredIndividualHistory = useMemo(() => {
    return individualHistory.filter((row) => {
      if (indDateFilter && row.date !== indDateFilter) return false;
      if (indMonthFilter && !String(row.date || '').startsWith(indMonthFilter)) return false;
      return true;
    });
  }, [individualHistory, indDateFilter, indMonthFilter]);

  const individualSummaryStats = useMemo(() => {
    let tw = 0;
    let tl = 0;
    let iz = 0;
    let sk = 0;
    for (const r of filteredIndividualHistory) {
      if (r.status === 'Tepat Waktu') tw++;
      else if (r.status === 'Terlambat') tl++;
      else if (r.status === 'Izin') iz++;
      else if (r.status === 'Sakit') sk++;
    }
    const total = filteredIndividualHistory.length;
    const hadir = tw + tl;
    const rate = total > 0 ? Math.round((hadir / total) * 100) : 0;
    return { tw, tl, iz, sk, total, hadir, rate };
  }, [filteredIndividualHistory]);

  const handleExportTeacherExcel = () => {
    const wb = XLSX.utils.book_new();
    if (teacherViewMode === 'individual' && selectedTeacherId) {
      const target = activeTeachers.find((t) => t.id === selectedTeacherId);
      const rows = filteredIndividualHistory.map((h, idx) => ({
        No: idx + 1,
        Tanggal: h.date,
        Sesi: h.sessionName || '-',
        Jam_Masuk: h.timeIn || '-',
        Jam_Pulang: h.timeOut || '-',
        Status: h.status,
        Metode: h.method || '-',
        Jarak_GPS_Meter: h.distanceMeters !== undefined ? h.distanceMeters : '-',
        Catatan: h.notes || '-',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'Riwayat_Guru');
      XLSX.writeFile(
        wb,
        `Riwayat_Presensi_${(target?.name || 'Guru').replace(/\s+/g, '_')}.xlsx`
      );
      return;
    }

    const summaryRows = filteredTeacherSummaries.map((row, idx) => ({
      No: idx + 1,
      Nama_Guru: row.teacherName,
      NIP: row.nip || '-',
      Jabatan_Mapel: row.subject || '-',
      Tepat_Waktu: row.tepatWaktu,
      Terlambat: row.terlambat,
      Izin: row.izin,
      Sakit: row.sakit,
      Total_Hadir: row.totalHadir,
      Tingkat_Hadir_Persen: `${row.attendanceRate}%`,
      Status_Terakhir: row.latestStatus,
    }));
    const ws = XLSX.utils.json_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Rekap_Guru');
    XLSX.writeFile(
      wb,
      `Rekap_Presensi_Guru_${tPeriod === 'monthly' ? tMonth : tDate}.xlsx`
    );
  };

  // ============================================================================
  // CLASS & PER-CLASS ATTENDANCE STATE (using homeroomRecap.ts single source of truth)
  // ============================================================================
  const [classViewMode, setClassViewMode] = useState<'all_classes' | 'per_class'>('all_classes');
  const [selectedClassId, setSelectedClassId] = useState<string>(classes[0]?.id || '');

  useEffect(() => {
    if (classes.length > 0 && !classes.some((c) => c.id === selectedClassId)) {
      setSelectedClassId(classes[0].id);
    }
  }, [classes, selectedClassId]);

  // All-Classes Overview Period
  const [allClsPeriod, setAllClsPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [allClsDate, setAllClsDate] = useState<string>(todayStr);
  const [allClsMonth, setAllClsMonth] = useState<string>(todayStr.slice(0, 7));
  const [allClsSession, setAllClsSession] = useState<string>('ALL');
  const [allClsSearch, setAllClsSearch] = useState<string>('');
  const [allClsLevelFilter, setAllClsLevelFilter] = useState<string>('ALL');
  const [allClsHistoryRecords, setAllClsHistoryRecords] = useState<StudentAttendance[]>([]);
  const [loadingAllCls, setLoadingAllCls] = useState<boolean>(false);

  const allClsDateBounds = useMemo(() => {
    if (allClsPeriod === 'daily') {
      return { startDate: allClsDate, endDate: allClsDate };
    }
    if (allClsPeriod === 'weekly') {
      const [y, m, d] = allClsDate.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      const diffToMon = (dt.getUTCDay() + 6) % 7;
      const st = new Date(dt);
      st.setUTCDate(dt.getUTCDate() - diffToMon);
      const en = new Date(st);
      en.setUTCDate(st.getUTCDate() + 6);
      return {
        startDate: st.toISOString().slice(0, 10),
        endDate: en.toISOString().slice(0, 10),
      };
    }
    return {
      startDate: `${allClsMonth}-01`,
      endDate: `${allClsMonth}-31`,
    };
  }, [allClsPeriod, allClsDate, allClsMonth]);

  const fetchAllClassesRecap = useCallback(async () => {
    setLoadingAllCls(true);
    try {
      const res = await gasGet<StudentRecapResponse>('studentRecap', {
        startDate: allClsDateBounds.startDate,
        endDate: allClsDateBounds.endDate,
        sessionId: allClsSession !== 'ALL' ? allClsSession : undefined,
      });
      if (res.success && Array.isArray((res as any).records)) {
        setAllClsHistoryRecords((res as unknown as StudentRecapResponse).records);
      }
    } catch (err) {
      console.error('Failed to load all-classes student recap:', err);
    } finally {
      setLoadingAllCls(false);
    }
  }, [allClsDateBounds.startDate, allClsDateBounds.endDate, allClsSession]);

  useEffect(() => {
    if (activeSubTab === 'classes_recap' && classViewMode === 'all_classes') {
      void fetchAllClassesRecap();
    }
  }, [activeSubTab, classViewMode, serverVersion, fetchAllClassesRecap]);

  const mergedAllClassesRecords = useMemo(
    () => mergeAttendanceSources(allClsHistoryRecords, todayAttendance),
    [allClsHistoryRecords, todayAttendance]
  );

  // Per-class recap rows for All-Classes overview (and Overview tab today quick view)
  const allClassesComputedRows = useMemo(() => {
    const q = allClsSearch.trim().toLowerCase();
    return classes
      .filter((c) => {
        if (allClsLevelFilter !== 'ALL' && String(c.level || '') !== allClsLevelFilter) return false;
        if (!q) return true;
        return (
          c.name.toLowerCase().includes(q) ||
          String(c.homeRoomTeacherName || '').toLowerCase().includes(q)
        );
      })
      .map((cls) => {
        const clsStudents = activeStudents.filter((s) => s.classId === cls.id);
        const clsStudentIds = new Set(clsStudents.map((s) => s.id));
        const idx = buildDailyAttendanceIndex(mergedAllClassesRecords, clsStudentIds, allClsSession);

        // Build candidate dates within bounds
        const datesInBounds: string[] = [];
        let cursor = allClsDateBounds.startDate;
        let safety = 0;
        while (cursor <= allClsDateBounds.endDate && safety < 40) {
          datesInBounds.push(cursor);
          cursor = shiftIsoDate(cursor, 1);
          safety++;
        }

        const res = computeRecapForDates(clsStudents, idx, datesInBounds);
        const belumAdaToday =
          allClsPeriod === 'daily'
            ? Math.max(0, clsStudents.length - res.totals.totalRecorded)
            : 0;
        return {
          cls,
          studentCount: clsStudents.length,
          totals: res.totals,
          belumAdaToday,
        };
      });
  }, [
    classes,
    activeStudents,
    mergedAllClassesRecords,
    allClsSession,
    allClsDateBounds,
    allClsPeriod,
    allClsSearch,
    allClsLevelFilter,
  ]);

  // Quick today class rows for Overview tab
  const overviewTodayClassRows = useMemo(() => {
    return classes.map((cls) => {
      const clsStudents = activeStudents.filter((s) => s.classId === cls.id);
      const clsStudentIds = new Set(clsStudents.map((s) => s.id));
      const idx = buildDailyAttendanceIndex(todayAttendance, clsStudentIds, 'ALL');
      const res = computeRecapForDates(clsStudents, idx, [todayStr]);
      return {
        cls,
        studentCount: clsStudents.length,
        hadir: res.totals.hadir,
        terlambat: res.totals.terlambat,
        izinSakit: res.totals.izin + res.totals.sakit,
        alpa: res.totals.alpa,
        rate:
          clsStudents.length > 0
            ? Math.round(((res.totals.hadir + res.totals.terlambat) / clsStudents.length) * 100)
            : 0,
      };
    });
  }, [classes, activeStudents, todayAttendance, todayStr]);

  // ============================================================================
  // PER-CLASS DETAILED DRILLDOWN STATE
  // ============================================================================
  const [clsPeriod, setClsPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'multi_month'>('daily');
  const [clsDate, setClsDate] = useState<string>(todayStr);
  const [clsMonth, setClsMonth] = useState<string>(todayStr.slice(0, 7));
  const [clsWeekNum, setClsWeekNum] = useState<number>(1);
  const [clsMultiMonths, setClsMultiMonths] = useState<string[]>([
    shiftYearMonth(todayStr.slice(0, 7), -1),
    todayStr.slice(0, 7),
  ]);
  const [clsSessionFilter, setClsSessionFilter] = useState<string>('ALL');
  const [clsStudentSearch, setClsStudentSearch] = useState<string>('');
  const [clsHistoryRecords, setClsHistoryRecords] = useState<StudentAttendance[]>([]);
  const [loadingClsRecap, setLoadingClsRecap] = useState<boolean>(false);
  const [detailStudent, setDetailStudent] = useState<Student | null>(null);

  const selectedClassObj = useMemo(
    () => classes.find((c) => c.id === selectedClassId) || null,
    [classes, selectedClassId]
  );
  const selectedClassStudents = useMemo(
    () => activeStudents.filter((s) => s.classId === selectedClassId),
    [activeStudents, selectedClassId]
  );
  const selectedClassStudentIdSet = useMemo(
    () => new Set(selectedClassStudents.map((s) => s.id)),
    [selectedClassStudents]
  );

  const clsWeeksInMonth = useMemo(() => getWeeksInMonth(clsMonth), [clsMonth]);
  useEffect(() => {
    if (clsWeeksInMonth.length > 0 && clsWeekNum > clsWeeksInMonth.length) {
      setClsWeekNum(clsWeeksInMonth.length);
    }
  }, [clsWeeksInMonth, clsWeekNum]);

  const clsFetchBounds = useMemo(() => {
    if (clsPeriod === 'daily') {
      return { startDate: clsDate, endDate: clsDate };
    }
    if (clsPeriod === 'weekly' || clsPeriod === 'monthly') {
      return { startDate: `${clsMonth}-01`, endDate: `${clsMonth}-31` };
    }
    const sorted = [...clsMultiMonths].sort();
    if (sorted.length === 0) {
      return { startDate: `${clsMonth}-01`, endDate: `${clsMonth}-31` };
    }
    return {
      startDate: `${sorted[0]}-01`,
      endDate: `${sorted[sorted.length - 1]}-31`,
    };
  }, [clsPeriod, clsDate, clsMonth, clsMultiMonths]);

  const fetchPerClassRecap = useCallback(async () => {
    if (!selectedClassId) return;
    setLoadingClsRecap(true);
    try {
      const res = await gasGet<StudentRecapResponse>('studentRecap', {
        classId: selectedClassId,
        startDate: clsFetchBounds.startDate,
        endDate: clsFetchBounds.endDate,
        sessionId: clsSessionFilter !== 'ALL' ? clsSessionFilter : undefined,
      });
      if (res.success && Array.isArray((res as any).records)) {
        setClsHistoryRecords((res as unknown as StudentRecapResponse).records);
      }
    } catch (err) {
      console.error('Failed to fetch per-class recap:', err);
    } finally {
      setLoadingClsRecap(false);
    }
  }, [selectedClassId, clsFetchBounds.startDate, clsFetchBounds.endDate, clsSessionFilter]);

  useEffect(() => {
    if (activeSubTab === 'classes_recap' && classViewMode === 'per_class' && selectedClassId) {
      void fetchPerClassRecap();
    }
  }, [activeSubTab, classViewMode, selectedClassId, serverVersion, fetchPerClassRecap]);

  const mergedPerClassRecords = useMemo(
    () => mergeAttendanceSources(clsHistoryRecords, todayAttendance),
    [clsHistoryRecords, todayAttendance]
  );

  const perClassDailyIndex = useMemo(
    () => buildDailyAttendanceIndex(mergedPerClassRecords, selectedClassStudentIdSet, clsSessionFilter),
    [mergedPerClassRecords, selectedClassStudentIdSet, clsSessionFilter]
  );

  const perClassActiveWeek = useMemo(
    () => clsWeeksInMonth.find((w) => w.weekNumber === clsWeekNum) || clsWeeksInMonth[0],
    [clsWeeksInMonth, clsWeekNum]
  );

  const perClassComputation = useMemo(() => {
    if (clsPeriod === 'daily') {
      return computeRecapForDates(selectedClassStudents, perClassDailyIndex, [clsDate]);
    }
    if (clsPeriod === 'weekly') {
      return computeRecapForDates(
        selectedClassStudents,
        perClassDailyIndex,
        perClassActiveWeek ? perClassActiveWeek.dates : []
      );
    }
    if (clsPeriod === 'monthly') {
      const weeksDates = clsWeeksInMonth.flatMap((w) => w.dates);
      return computeRecapForDates(selectedClassStudents, perClassDailyIndex, weeksDates);
    }
    const mm = computeMultiMonthRecap(selectedClassStudents, perClassDailyIndex, clsMultiMonths);
    return mm.combined;
  }, [
    clsPeriod,
    selectedClassStudents,
    perClassDailyIndex,
    clsDate,
    perClassActiveWeek,
    clsWeeksInMonth,
    clsMultiMonths,
  ]);

  const filteredPerClassStudentRows = useMemo(() => {
    const q = clsStudentSearch.trim().toLowerCase();
    return perClassComputation.studentRows.filter((row) => {
      if (!q) return true;
      return (
        row.student.name.toLowerCase().includes(q) ||
        row.student.nis.toLowerCase().includes(q)
      );
    });
  }, [perClassComputation.studentRows, clsStudentSearch]);

  const handleOpenClassDetail = (classId: string) => {
    setSelectedClassId(classId);
    setClassViewMode('per_class');
    setActiveSubTab('classes_recap');
  };

  const handleOpenTeacherDetail = (teacherId: string) => {
    setSelectedTeacherId(teacherId);
    setTeacherViewMode('individual');
    setActiveSubTab('teacher_recap');
  };

  const handleToggleMultiMonth = (ym: string) => {
    setClsMultiMonths((prev) =>
      prev.includes(ym) ? (prev.length > 1 ? prev.filter((m) => m !== ym) : prev) : [...prev, ym].sort()
    );
  };

  const recentSelectableMonths = useMemo(() => {
    const list: string[] = [];
    for (let i = -5; i <= 0; i++) {
      list.push(shiftYearMonth(todayStr.slice(0, 7), i));
    }
    return list;
  }, [todayStr]);

  const handleExportClassesExcel = () => {
    const wb = XLSX.utils.book_new();
    if (classViewMode === 'all_classes') {
      const rows = allClassesComputedRows.map((r, idx) => ({
        No: idx + 1,
        Kelas: r.cls.name,
        Jenjang: r.cls.level || '-',
        Wali_Kelas: r.cls.homeRoomTeacherName || '-',
        Jumlah_Siswa: r.studentCount,
        Hadir: r.totals.hadir,
        Terlambat: r.totals.terlambat,
        Izin: r.totals.izin,
        Sakit: r.totals.sakit,
        Alpa: r.totals.alpa,
        Tingkat_Hadir_Persen: `${r.totals.attendanceRate}%`,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'Rekap_Semua_Kelas');
      XLSX.writeFile(wb, `Rekap_Presensi_Semua_Kelas_${allClsDateBounds.startDate}.xlsx`);
      return;
    }

    const rows = filteredPerClassStudentRows.map((row, idx) => ({
      No: idx + 1,
      NIS: row.student.nis,
      Nama_Siswa: row.student.name,
      Hadir: row.hadir,
      Terlambat: row.terlambat,
      Izin: row.izin,
      Sakit: row.sakit,
      Alpa: row.alpa,
      Belum_Tercatat: row.belumAda,
      Tingkat_Hadir_Persen: `${row.attendanceRate}%`,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Presensi_Kelas');
    XLSX.writeFile(
      wb,
      `Presensi_Kelas_${(selectedClassObj?.name || 'Kelas').replace(/\s+/g, '_')}_${clsFetchBounds.startDate}.xlsx`
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header Banner */}
      <div className="rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-950 to-blue-900 p-6 sm:p-8 text-white shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 text-xs font-bold text-blue-200">
              <ShieldCheck className="w-4 h-4" />
              <span>Menu Kepala Sekolah • {settings?.schoolName || 'Yayasan Mambaul Ulum'}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
              Dashboard Monitoring Kepala Sekolah
            </h1>
            <p className="text-xs sm:text-sm text-blue-100/80 max-w-2xl">
              Pantau ringkasan sekolah, riwayat presensi per guru, rekap kehadiran kelas maupun per kelas, dan daftar buku tamu sekolah secara real-time.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 bg-white/10 p-1.5 rounded-2xl border border-white/15 self-start lg:self-center">
            {[
              { id: 'overview' as PrincipalSubTab, label: 'Ringkasan', icon: <LayoutDashboard className="w-4 h-4" /> },
              { id: 'teacher_recap' as PrincipalSubTab, label: 'Presensi Guru', icon: <Briefcase className="w-4 h-4" /> },
              { id: 'classes_recap' as PrincipalSubTab, label: 'Kelas & Per Kelas', icon: <GraduationCap className="w-4 h-4" /> },
              { id: 'guest_book' as PrincipalSubTab, label: 'Riwayat Tamu', icon: <BookOpen className="w-4 h-4" /> },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSubTab(tab.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
                  activeSubTab === tab.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-white/85 hover:text-white hover:bg-white/10'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* TAB 1: RINGKASAN SEKOLAH */}
      {activeSubTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Siswa Aktif</span>
                <GraduationCap className="w-5 h-5 text-blue-600" />
              </div>
              <div className="text-2xl font-black text-slate-900 dark:text-white tabular-nums">
                {activeStudents.length}
              </div>
              <div className="text-[11px] text-slate-500">
                {classes.length} kelas • {enrolledStudentFaces} wajah terdaftar
              </div>
            </div>

            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Siswa Hadir Hari Ini</span>
                <UserCheck className="w-5 h-5 text-emerald-600" />
              </div>
              <div className="text-2xl font-black text-emerald-600 tabular-nums">
                {presentStudentsToday}
              </div>
              <div className="text-[11px] text-slate-500">
                {lateStudentsToday} terlambat • Dari {activeStudents.length} siswa
              </div>
            </div>

            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Guru Hadir Hari Ini</span>
                <Briefcase className="w-5 h-5 text-indigo-600" />
              </div>
              <div className="text-2xl font-black text-indigo-600 tabular-nums">
                {teacherRecap ? teacherRecap.totals.hadirTotal : 0}{' '}
                <span className="text-sm font-bold text-slate-400">/ {activeTeachers.length}</span>
              </div>
              <div className="text-[11px] text-slate-500">
                {enrolledTeacherFaces} wajah guru terdaftar • Klik tab Presensi Guru
              </div>
            </div>

            <div className="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Tamu Sekolah Hari Ini</span>
                <BookOpen className="w-5 h-5 text-teal-600" />
              </div>
              <div className="text-2xl font-black text-teal-600 tabular-nums">
                {guestTodayCount}
              </div>
              <div className="text-[11px] text-slate-500">
                Total {guestBook.length} kunjungan tercatat • Versi DB v{serverVersion}
              </div>
            </div>
          </div>

          {/* Quick Class Attendance Today */}
          <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                  <GraduationCap className="w-4 h-4 text-blue-600" />
                  <span>Kehadiran Per Kelas Hari Ini ({formatIndoDate(todayStr)})</span>
                </h3>
                <p className="text-xs text-slate-500">
                  Klik nama kelas untuk membuka riwayat &amp; rekap detail kelas tersebut.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveSubTab('classes_recap')}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-xs font-bold transition cursor-pointer"
              >
                <span>Buka Rekap Lengkap Kelas</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {overviewTodayClassRows.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">Belum ada data kelas.</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {overviewTodayClassRows.map((row) => (
                  <button
                    key={row.cls.id}
                    type="button"
                    onClick={() => handleOpenClassDetail(row.cls.id)}
                    className="p-4 rounded-2xl bg-slate-50 hover:bg-blue-50/70 dark:bg-slate-800/60 dark:hover:bg-blue-950/30 border border-slate-200 dark:border-slate-700 text-left transition cursor-pointer space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-black text-sm text-slate-900 dark:text-white">
                          {row.cls.name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Wali: {row.cls.homeRoomTeacherName || '-'} • {row.studentCount} siswa
                        </div>
                      </div>
                      <span className="text-xs font-black text-blue-600 dark:text-blue-400 tabular-nums">
                        {row.rate}%
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
                      <span className="text-emerald-700 dark:text-emerald-300">Hadir: {row.hadir}</span>
                      <span className="text-amber-700 dark:text-amber-300">Telat: {row.terlambat}</span>
                      <span className="text-blue-700 dark:text-blue-300">I/S: {row.izinSakit}</span>
                      <span className="text-red-600 dark:text-red-400">Alpa: {row.alpa}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Latest Student Attendance Feed */}
          <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-blue-600" />
                <span>
                  Log Kehadiran Siswa Hari Ini
                  {activeStudentSession ? ` (${activeStudentSession.name})` : ''}
                </span>
              </h3>
              <span className="text-[11px] text-slate-400">
                {lastSyncedAt ? `Sinkron otomatis: ${formatWibTime24(lastSyncedAt, true)} WIB` : ''}
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
                            className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${getStudentStatusClass(
                              row.status
                            )}`}
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

      {/* TAB 2: RIWAYAT & REKAP PRESENSI GURU + PER GURU */}
      {activeSubTab === 'teacher_recap' && (
        <div className="space-y-6">
          {/* Header Mode Switcher & Filters */}
          <div className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                  <Briefcase className="w-5 h-5 text-indigo-600" />
                  <span>Riwayat &amp; Rekap Presensi Guru</span>
                </h2>
                <p className="text-xs text-slate-500">
                  Cek kehadiran seluruh guru per hari/pekan/bulan maupun riwayat lengkap per masing-masing guru.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-xl p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <button
                    type="button"
                    onClick={() => setTeacherViewMode('all')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      teacherViewMode === 'all'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Semua Guru
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTeacherViewMode('individual');
                      if (!selectedTeacherId && activeTeachers[0]) {
                        setSelectedTeacherId(activeTeachers[0].id);
                      }
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      teacherViewMode === 'individual'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Riwayat Per Guru
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleExportTeacherExcel}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Ekspor Excel</span>
                </button>
              </div>
            </div>

            {teacherViewMode === 'all' ? (
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-xl p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                    {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setTPeriod(p)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                          tPeriod === p
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-500'
                        }`}
                      >
                        {p === 'daily' ? 'Harian' : p === 'weekly' ? 'Mingguan' : 'Bulanan'}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleStepTeacherPeriod(-1)}
                    className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Sebelum</span>
                  </button>

                  {tPeriod === 'monthly' ? (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                      <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                      <input
                        type="month"
                        value={tMonth}
                        onChange={(e) => e.target.value && setTMonth(e.target.value)}
                        className="text-xs font-bold bg-transparent focus:outline-none"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                      <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                      <input
                        type="date"
                        value={tDate}
                        onChange={(e) => e.target.value && setTDate(e.target.value)}
                        className="text-xs font-bold bg-transparent focus:outline-none"
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setTDate(todayStr);
                      setTMonth(todayStr.slice(0, 7));
                    }}
                    className="px-3 py-2 rounded-xl text-xs font-bold bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800"
                  >
                    {tPeriod === 'daily' ? 'Hari Ini' : tPeriod === 'weekly' ? 'Pekan Ini' : 'Bulan Ini'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleStepTeacherPeriod(1)}
                    className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                  >
                    <span>Sesudah</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={tSearch}
                      onChange={(e) => setTSearch(e.target.value)}
                      placeholder="Cari guru / NIP..."
                      className="pl-8 pr-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    />
                  </div>

                  {teacherSessions.length > 0 && (
                    <select
                      value={tSessionFilter}
                      onChange={(e) => setTSessionFilter(e.target.value)}
                      className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    >
                      <option value="ALL">Semua Sesi Guru</option>
                      {teacherSessions.map((ses) => (
                        <option key={ses.id} value={ses.id}>
                          {ses.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <select
                    value={tStatusFilter}
                    onChange={(e) => setTStatusFilter(e.target.value)}
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
            ) : (
              <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <select
                  value={selectedTeacherId}
                  onChange={(e) => setSelectedTeacherId(e.target.value)}
                  className="px-3.5 py-2.5 min-h-[42px] text-xs font-bold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl min-w-[220px]"
                >
                  <option value="">-- Pilih Nama Guru --</option>
                  {activeTeachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.nip || t.subject || 'Guru'})
                    </option>
                  ))}
                </select>

                {teacherSessions.length > 0 && (
                  <select
                    value={tSessionFilter}
                    onChange={(e) => setTSessionFilter(e.target.value)}
                    className="px-3 py-2.5 min-h-[42px] text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="ALL">Semua Sesi</option>
                    {teacherSessions.map((ses) => (
                      <option key={ses.id} value={ses.id}>
                        {ses.name}
                      </option>
                    ))}
                  </select>
                )}

                <div className="flex items-center gap-1.5 px-3 py-2 min-h-[42px] rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <span className="text-[11px] font-semibold text-slate-500">Tanggal:</span>
                  <input
                    type="date"
                    value={indDateFilter}
                    onChange={(e) => {
                      setIndDateFilter(e.target.value);
                      if (e.target.value) setIndMonthFilter('');
                    }}
                    className="text-xs font-bold bg-transparent focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1.5 px-3 py-2 min-h-[42px] rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <span className="text-[11px] font-semibold text-slate-500">Bulan:</span>
                  <input
                    type="month"
                    value={indMonthFilter}
                    onChange={(e) => {
                      setIndMonthFilter(e.target.value);
                      if (e.target.value) setIndDateFilter('');
                    }}
                    className="text-xs font-bold bg-transparent focus:outline-none"
                  />
                </div>

                {(indDateFilter || indMonthFilter) && (
                  <button
                    type="button"
                    onClick={() => {
                      setIndDateFilter('');
                      setIndMonthFilter('');
                    }}
                    className="px-3 py-2 min-h-[42px] rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                  >
                    Semua Riwayat
                  </button>
                )}
              </div>
            )}
          </div>

          {teacherViewMode === 'all' ? (
            <>
              {teacherRecap && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-400 font-semibold">Guru Aktif</div>
                    <div className="text-2xl font-black text-slate-900 dark:text-white mt-1 tabular-nums">
                      {filteredTeacherSummaries.length}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-300 font-semibold">Tepat Waktu</div>
                    <div className="text-2xl font-black text-emerald-700 dark:text-emerald-300 mt-1 tabular-nums">
                      {teacherRecap.totals.tepatWaktu}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
                    <div className="text-[11px] text-amber-700 dark:text-amber-300 font-semibold">Terlambat</div>
                    <div className="text-2xl font-black text-amber-700 dark:text-amber-300 mt-1 tabular-nums">
                      {teacherRecap.totals.terlambat}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900">
                    <div className="text-[11px] text-blue-700 dark:text-blue-300 font-semibold">Izin / Sakit</div>
                    <div className="text-2xl font-black text-blue-700 dark:text-blue-300 mt-1 tabular-nums">
                      {teacherRecap.totals.izin + teacherRecap.totals.sakit}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 col-span-2 sm:col-span-1">
                    <div className="text-[11px] text-slate-400 font-semibold">Tingkat Hadir</div>
                    <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 mt-1 tabular-nums">
                      {teacherRecap.totals.attendanceRate}%
                    </div>
                  </div>
                </div>
              )}

              <div className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                    {tPeriod === 'daily'
                      ? `Kehadiran Guru (${formatIndoDate(tDate)})`
                      : tPeriod === 'weekly'
                      ? `Rekap Mingguan (${teacherRecap ? `${formatIndoDate(teacherRecap.rangeStart)} – ${formatIndoDate(teacherRecap.rangeEnd)}` : ''})`
                      : `Rekap Bulanan (${formatIndoMonth(tMonth)})`}
                  </h3>
                  <span className="text-xs text-slate-400">Klik tombol Riwayat untuk cek detail guru</span>
                </div>

                {loadingTeacherRecap && !teacherRecap ? (
                  <div className="py-10 text-center text-xs text-slate-400">Memuat data presensi guru...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                          <th className="py-3 px-3">Guru &amp; NIP</th>
                          <th className="py-3 px-3">Mapel / Jabatan</th>
                          {tPeriod === 'daily' ? (
                            <>
                              <th className="py-3 px-3">Masuk</th>
                              <th className="py-3 px-3">Pulang</th>
                              <th className="py-3 px-3">Status</th>
                              <th className="py-3 px-3">Catatan</th>
                            </>
                          ) : (
                            <>
                              <th className="py-3 px-3 text-center">Tepat Waktu</th>
                              <th className="py-3 px-3 text-center">Terlambat</th>
                              <th className="py-3 px-3 text-center">Izin</th>
                              <th className="py-3 px-3 text-center">Sakit</th>
                              <th className="py-3 px-3 text-center">Total Hadir</th>
                              <th className="py-3 px-3 text-center">% Hadir</th>
                            </>
                          )}
                          <th className="py-3 px-3 text-right">Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {filteredTeacherSummaries.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="py-8 text-center text-slate-400">
                              Tidak ada data guru yang sesuai filter.
                            </td>
                          </tr>
                        ) : (
                          filteredTeacherSummaries.map((row) => (
                            <tr key={row.teacherId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                              <td className="py-3 px-3">
                                <div className="font-bold text-slate-900 dark:text-white">{row.teacherName}</div>
                                <div className="text-[11px] font-mono text-slate-400">NIP: {row.nip || '-'}</div>
                              </td>
                              <td className="py-3 px-3 text-slate-600 dark:text-slate-300">{row.subject || '-'}</td>
                              {tPeriod === 'daily' ? (
                                <>
                                  <td className="py-3 px-3 font-mono">{row.latestTimeIn || '-'}</td>
                                  <td className="py-3 px-3 font-mono">{row.latestTimeOut || '-'}</td>
                                  <td className="py-3 px-3">
                                    <span
                                      className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${getTeacherStatusClass(
                                        row.latestStatus
                                      )}`}
                                    >
                                      {row.latestStatus}
                                    </span>
                                  </td>
                                  <td className="py-3 px-3 text-slate-500">
                                    {row.latestMethod || '-'} {row.notes ? `• ${row.notes}` : ''}
                                  </td>
                                </>
                              ) : (
                                <>
                                  <td className="py-3 px-3 text-center font-bold text-emerald-600">{row.tepatWaktu}</td>
                                  <td className="py-3 px-3 text-center font-bold text-amber-600">{row.terlambat}</td>
                                  <td className="py-3 px-3 text-center font-bold text-blue-600">{row.izin}</td>
                                  <td className="py-3 px-3 text-center font-bold text-purple-600">{row.sakit}</td>
                                  <td className="py-3 px-3 text-center font-black">
                                    {row.totalHadir} <span className="text-[10px] font-normal text-slate-400">/ {row.totalRecorded}</span>
                                  </td>
                                  <td className="py-3 px-3 text-center font-bold text-indigo-600">
                                    {row.attendanceRate}%
                                  </td>
                                </>
                              )}
                              <td className="py-3 px-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleOpenTeacherDetail(row.teacherId)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold transition cursor-pointer"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  <span>Riwayat</span>
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Log Detail records when weekly/monthly */}
              {teacherRecap && tPeriod !== 'daily' && (
                <div className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                      Log Detail Presensi Periode Ini ({filteredTeacherRecords.length} Baris)
                    </h4>
                  </div>
                  <div className="overflow-x-auto max-h-[340px]">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                          <th className="py-2 px-3">Tanggal</th>
                          <th className="py-2 px-3">Sesi</th>
                          <th className="py-2 px-3">Nama Guru</th>
                          <th className="py-2 px-3">Masuk</th>
                          <th className="py-2 px-3">Pulang</th>
                          <th className="py-2 px-3">Status</th>
                          <th className="py-2 px-3">Lokasi / Catatan</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {filteredTeacherRecords.map((rec) => (
                          <tr key={rec.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-2.5 px-3 font-semibold">{formatIndoDate(rec.date)}</td>
                            <td className="py-2.5 px-3 text-indigo-600 font-semibold">{rec.sessionName || '-'}</td>
                            <td className="py-2.5 px-3 font-bold text-slate-900 dark:text-white">{rec.teacherName}</td>
                            <td className="py-2.5 px-3 font-mono">{rec.timeIn || '-'}</td>
                            <td className="py-2.5 px-3 font-mono">{rec.timeOut || '-'}</td>
                            <td className="py-2.5 px-3">
                              <span
                                className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${getTeacherStatusClass(
                                  rec.status
                                )}`}
                              >
                                {rec.status}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-slate-500">
                              {rec.distanceMeters !== undefined ? `${rec.distanceMeters}m GPS • ` : ''}
                              {rec.notes || rec.method || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* INDIVIDUAL TEACHER HISTORY VIEW */
            <div className="space-y-4">
              {selectedTeacherId && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-400 font-semibold">Total Catatan</div>
                    <div className="text-2xl font-black text-slate-900 dark:text-white mt-1 tabular-nums">
                      {individualSummaryStats.total}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-300 font-semibold">Tepat Waktu</div>
                    <div className="text-2xl font-black text-emerald-700 dark:text-emerald-300 mt-1 tabular-nums">
                      {individualSummaryStats.tw}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
                    <div className="text-[11px] text-amber-700 dark:text-amber-300 font-semibold">Terlambat</div>
                    <div className="text-2xl font-black text-amber-700 dark:text-amber-300 mt-1 tabular-nums">
                      {individualSummaryStats.tl}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900">
                    <div className="text-[11px] text-blue-700 dark:text-blue-300 font-semibold">Izin / Sakit</div>
                    <div className="text-2xl font-black text-blue-700 dark:text-blue-300 mt-1 tabular-nums">
                      {individualSummaryStats.iz + individualSummaryStats.sk}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 col-span-2 sm:col-span-1">
                    <div className="text-[11px] text-slate-400 font-semibold">Tingkat Hadir</div>
                    <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 mt-1 tabular-nums">
                      {individualSummaryStats.rate}%
                    </div>
                  </div>
                </div>
              )}

              <div className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
                {!selectedTeacherId ? (
                  <div className="py-10 text-center text-xs text-slate-400">
                    Silakan pilih nama guru di atas untuk menampilkan riwayat kehadirannya.
                  </div>
                ) : loadingIndividual ? (
                  <div className="py-10 text-center text-xs text-slate-400">
                    Memuat riwayat presensi guru...
                  </div>
                ) : filteredIndividualHistory.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-400">
                    Belum ada catatan presensi pada filter ini.
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-[500px]">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                          <th className="py-2.5 px-3">Tanggal</th>
                          <th className="py-2.5 px-3">Sesi</th>
                          <th className="py-2.5 px-3">Jam Masuk</th>
                          <th className="py-2.5 px-3">Jam Pulang</th>
                          <th className="py-2.5 px-3">Status</th>
                          <th className="py-2.5 px-3">Metode &amp; GPS</th>
                          <th className="py-2.5 px-3">Catatan</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {filteredIndividualHistory.map((h) => (
                          <tr key={h.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-white">
                              {formatIndoDate(h.date)}
                            </td>
                            <td className="py-2.5 px-3 text-indigo-600 font-semibold">
                              {h.sessionName || '-'}
                            </td>
                            <td className="py-2.5 px-3 font-mono">{h.timeIn || '-'}</td>
                            <td className="py-2.5 px-3 font-mono">{h.timeOut || '-'}</td>
                            <td className="py-2.5 px-3">
                              <span
                                className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${getTeacherStatusClass(
                                  h.status
                                )}`}
                              >
                                {h.status}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">
                              <div className="flex items-center gap-1.5">
                                <span>{h.method || '-'}</span>
                                {h.distanceMeters !== undefined && (
                                  <span className="inline-flex items-center gap-0.5 text-[11px] text-slate-500">
                                    <MapPin className="w-3 h-3" />
                                    {h.distanceMeters}m
                                    {h.accuracyMeters !== undefined ? ` (±${h.accuracyMeters}m)` : ''}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-slate-500 italic">{h.notes || '-'}</td>
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
      )}

      {/* TAB 3: REKAP PRESENSI KELAS & PER KELAS */}
      {activeSubTab === 'classes_recap' && (
        <div className="space-y-6">
          <div className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                  <GraduationCap className="w-5 h-5 text-blue-600" />
                  <span>Rekapitulasi Presensi Kelas &amp; Per Kelas</span>
                </h2>
                <p className="text-xs text-slate-500">
                  Lihat ringkasan seluruh kelas atau pilih salah satu kelas untuk cek detail siswa per hari, per pekan, bulanan, dan antar bulanan.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-xl p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                  <button
                    type="button"
                    onClick={() => setClassViewMode('all_classes')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      classViewMode === 'all_classes'
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Semua Kelas
                  </button>
                  <button
                    type="button"
                    onClick={() => setClassViewMode('per_class')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      classViewMode === 'per_class'
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Detail Per Kelas
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleExportClassesExcel}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Ekspor Excel</span>
                </button>
              </div>
            </div>

            {classViewMode === 'all_classes' ? (
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-xl p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                    {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setAllClsPeriod(p)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                          allClsPeriod === p
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-500'
                        }`}
                      >
                        {p === 'daily' ? 'Harian' : p === 'weekly' ? 'Mingguan' : 'Bulanan'}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (allClsPeriod === 'daily') setAllClsDate((d) => shiftIsoDate(d, -1));
                      else if (allClsPeriod === 'weekly') setAllClsDate((d) => shiftIsoDate(d, -7));
                      else setAllClsMonth((m) => shiftYearMonth(m, -1));
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Sebelum</span>
                  </button>

                  {allClsPeriod === 'monthly' ? (
                    <input
                      type="month"
                      value={allClsMonth}
                      onChange={(e) => e.target.value && setAllClsMonth(e.target.value)}
                      className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold"
                    />
                  ) : (
                    <input
                      type="date"
                      value={allClsDate}
                      onChange={(e) => e.target.value && setAllClsDate(e.target.value)}
                      className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold"
                    />
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setAllClsDate(todayStr);
                      setAllClsMonth(todayStr.slice(0, 7));
                    }}
                    className="px-3 py-2 rounded-xl text-xs font-bold bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                  >
                    {allClsPeriod === 'daily' ? 'Hari Ini' : allClsPeriod === 'weekly' ? 'Pekan Ini' : 'Bulan Ini'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (allClsPeriod === 'daily') setAllClsDate((d) => shiftIsoDate(d, 1));
                      else if (allClsPeriod === 'weekly') setAllClsDate((d) => shiftIsoDate(d, 7));
                      else setAllClsMonth((m) => shiftYearMonth(m, 1));
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                  >
                    <span>Sesudah</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={allClsSearch}
                      onChange={(e) => setAllClsSearch(e.target.value)}
                      placeholder="Cari kelas / wali kelas..."
                      className="pl-8 pr-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    />
                  </div>

                  <select
                    value={allClsLevelFilter}
                    onChange={(e) => setAllClsLevelFilter(e.target.value)}
                    className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                  >
                    <option value="ALL">Semua Jenjang</option>
                    <option value="SD/MI">SD/MI</option>
                    <option value="SMP/MTS">SMP/MTS</option>
                    <option value="SMK">SMK</option>
                  </select>

                  {studentSessions.length > 0 && (
                    <select
                      value={allClsSession}
                      onChange={(e) => setAllClsSession(e.target.value)}
                      className="px-3 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    >
                      <option value="ALL">Semua Sesi Siswa</option>
                      {studentSessions.map((ses) => (
                        <option key={ses.id} value={ses.id}>
                          {ses.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ) : (
              /* PER-CLASS FILTERS */
              <div className="space-y-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={selectedClassId}
                    onChange={(e) => setSelectedClassId(e.target.value)}
                    className="px-3.5 py-2 min-h-[40px] text-xs font-bold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl min-w-[200px]"
                  >
                    {classes.length === 0 && <option value="">Belum ada kelas</option>}
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.homeRoomTeacherName ? `• Wali: ${c.homeRoomTeacherName}` : ''}
                      </option>
                    ))}
                  </select>

                  <div className="inline-flex rounded-xl p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                    {(['daily', 'weekly', 'monthly', 'multi_month'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setClsPeriod(p)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                          clsPeriod === p
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-500'
                        }`}
                      >
                        {p === 'daily'
                          ? 'Harian'
                          : p === 'weekly'
                          ? 'Antar Pekan'
                          : p === 'monthly'
                          ? 'Bulanan'
                          : 'Antar Bulanan'}
                      </button>
                    ))}
                  </div>

                  {studentSessions.length > 0 && (
                    <select
                      value={clsSessionFilter}
                      onChange={(e) => setClsSessionFilter(e.target.value)}
                      className="px-3 py-2 min-h-[40px] text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    >
                      <option value="ALL">Semua Sesi</option>
                      {studentSessions.map((ses) => (
                        <option key={ses.id} value={ses.id}>
                          {ses.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <div className="relative flex-1 min-w-[180px]">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={clsStudentSearch}
                      onChange={(e) => setClsStudentSearch(e.target.value)}
                      placeholder="Cari nama / NIS siswa..."
                      className="w-full pl-8 pr-3 py-2 min-h-[40px] text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl"
                    />
                  </div>
                </div>

                {/* Period Sub-controls */}
                {clsPeriod === 'daily' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setClsDate((d) => shiftIsoDate(d, -1))}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>Sebelum</span>
                    </button>
                    <input
                      type="date"
                      value={clsDate}
                      onChange={(e) => e.target.value && setClsDate(e.target.value)}
                      className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold"
                    />
                    <button
                      type="button"
                      onClick={() => setClsDate(todayStr)}
                      className="px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                    >
                      Hari Ini
                    </button>
                    <button
                      type="button"
                      onClick={() => setClsDate((d) => shiftIsoDate(d, 1))}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800"
                    >
                      <span>Sesudah</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {(clsPeriod === 'weekly' || clsPeriod === 'monthly') && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setClsMonth((m) => shiftYearMonth(m, -1))}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>Bulan Lalu</span>
                    </button>
                    <input
                      type="month"
                      value={clsMonth}
                      onChange={(e) => e.target.value && setClsMonth(e.target.value)}
                      className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold"
                    />
                    <button
                      type="button"
                      onClick={() => setClsMonth((m) => shiftYearMonth(m, 1))}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800"
                    >
                      <span>Bulan Berikut</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>

                    {clsPeriod === 'weekly' && (
                      <div className="flex flex-wrap items-center gap-1.5 ml-1">
                        {clsWeeksInMonth.map((w) => (
                          <button
                            key={w.weekNumber}
                            type="button"
                            onClick={() => setClsWeekNum(w.weekNumber)}
                            className={`px-2.5 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer ${
                              clsWeekNum === w.weekNumber
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
                            }`}
                          >
                            {w.label} ({w.shortRange})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {clsPeriod === 'multi_month' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-slate-500">Pilih Bulan:</span>
                    {recentSelectableMonths.map((ym) => {
                      const active = clsMultiMonths.includes(ym);
                      return (
                        <button
                          key={ym}
                          type="button"
                          onClick={() => handleToggleMultiMonth(ym)}
                          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer ${
                            active
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
                          }`}
                        >
                          {active && <CheckCircle2 className="w-3.5 h-3.5" />}
                          <span>{formatIndoMonthShort(ym)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {classViewMode === 'all_classes' ? (
            <div className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Ringkasan Seluruh Kelas ({formatIndoDate(allClsDateBounds.startDate)}
                  {allClsDateBounds.startDate !== allClsDateBounds.endDate
                    ? ` – ${formatIndoDate(allClsDateBounds.endDate)}`
                    : ''}
                  )
                </h3>
                <span className="text-xs text-slate-400">{allClassesComputedRows.length} Kelas</span>
              </div>

              {loadingAllCls && allClsHistoryRecords.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">Memuat rekap kelas...</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                        <th className="py-3 px-3">Kelas &amp; Jenjang</th>
                        <th className="py-3 px-3">Wali Kelas</th>
                        <th className="py-3 px-3 text-center">Siswa</th>
                        <th className="py-3 px-3 text-center">Hadir</th>
                        <th className="py-3 px-3 text-center">Terlambat</th>
                        <th className="py-3 px-3 text-center">Izin</th>
                        <th className="py-3 px-3 text-center">Sakit</th>
                        <th className="py-3 px-3 text-center">Alpa</th>
                        <th className="py-3 px-3 text-center">% Hadir</th>
                        <th className="py-3 px-3 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {allClassesComputedRows.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="py-8 text-center text-slate-400">
                            Tidak ada kelas sesuai filter.
                          </td>
                        </tr>
                      ) : (
                        allClassesComputedRows.map((row) => (
                          <tr key={row.cls.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-3 px-3">
                              <div className="font-bold text-slate-900 dark:text-white">{row.cls.name}</div>
                              <div className="text-[11px] text-slate-400">{row.cls.level || 'SMK'}</div>
                            </td>
                            <td className="py-3 px-3 text-slate-600 dark:text-slate-300">
                              {row.cls.homeRoomTeacherName || '-'}
                            </td>
                            <td className="py-3 px-3 text-center font-bold">{row.studentCount}</td>
                            <td className="py-3 px-3 text-center font-bold text-emerald-600">{row.totals.hadir}</td>
                            <td className="py-3 px-3 text-center font-bold text-amber-600">{row.totals.terlambat}</td>
                            <td className="py-3 px-3 text-center font-bold text-blue-600">{row.totals.izin}</td>
                            <td className="py-3 px-3 text-center font-bold text-purple-600">{row.totals.sakit}</td>
                            <td className="py-3 px-3 text-center font-bold text-red-600">{row.totals.alpa}</td>
                            <td className="py-3 px-3 text-center font-black text-indigo-600 tabular-nums">
                              {row.totals.attendanceRate}%
                            </td>
                            <td className="py-3 px-3 text-right">
                              <button
                                type="button"
                                onClick={() => handleOpenClassDetail(row.cls.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-[11px] font-bold transition cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>Per Kelas</span>
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            /* PER-CLASS MATRIX */
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-400 font-semibold">Siswa Kelas</div>
                  <div className="text-2xl font-black text-slate-900 dark:text-white mt-1 tabular-nums">
                    {selectedClassStudents.length}
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
                  <div className="text-[11px] text-emerald-700 dark:text-emerald-300 font-semibold">Hadir</div>
                  <div className="text-2xl font-black text-emerald-700 dark:text-emerald-300 mt-1 tabular-nums">
                    {perClassComputation.totals.hadir}
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
                  <div className="text-[11px] text-amber-700 dark:text-amber-300 font-semibold">Terlambat</div>
                  <div className="text-2xl font-black text-amber-700 dark:text-amber-300 mt-1 tabular-nums">
                    {perClassComputation.totals.terlambat}
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900">
                  <div className="text-[11px] text-blue-700 dark:text-blue-300 font-semibold">Izin / Sakit</div>
                  <div className="text-2xl font-black text-blue-700 dark:text-blue-300 mt-1 tabular-nums">
                    {perClassComputation.totals.izin + perClassComputation.totals.sakit}
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-red-50/70 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
                  <div className="text-[11px] text-red-700 dark:text-red-300 font-semibold">Alpa</div>
                  <div className="text-2xl font-black text-red-700 dark:text-red-300 mt-1 tabular-nums">
                    {perClassComputation.totals.alpa}
                  </div>
                </div>
                <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-400 font-semibold">Tingkat Hadir</div>
                  <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 mt-1 tabular-nums">
                    {perClassComputation.totals.attendanceRate}%
                  </div>
                </div>
              </div>

              <div className="p-5 sm:p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                      Presensi Kelas {selectedClassObj?.name || '-'}
                      {selectedClassObj?.homeRoomTeacherName
                        ? ` • Wali Kelas: ${selectedClassObj.homeRoomTeacherName}`
                        : ''}
                    </h3>
                    <p className="text-xs text-slate-500">
                      Klik baris siswa untuk melihat rincian tanggal kehadiran siswa.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setClassViewMode('all_classes')}
                    className="text-xs font-bold text-blue-600 hover:underline cursor-pointer"
                  >
                    &larr; Kembali ke Semua Kelas
                  </button>
                </div>

                {loadingClsRecap && clsHistoryRecords.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-400">
                    Memuat data presensi kelas...
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400 uppercase font-semibold">
                          <th className="py-3 px-3">NIS</th>
                          <th className="py-3 px-3">Nama Siswa</th>
                          {clsPeriod === 'daily' ? (
                            <>
                              <th className="py-3 px-3">Jam Masuk</th>
                              <th className="py-3 px-3">Sesi</th>
                              <th className="py-3 px-3">Status</th>
                              <th className="py-3 px-3">Metode &amp; Catatan</th>
                            </>
                          ) : (
                            <>
                              <th className="py-3 px-3 text-center">H</th>
                              <th className="py-3 px-3 text-center">T</th>
                              <th className="py-3 px-3 text-center">I</th>
                              <th className="py-3 px-3 text-center">S</th>
                              <th className="py-3 px-3 text-center">A</th>
                              <th className="py-3 px-3 text-center">% Hadir</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {filteredPerClassStudentRows.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="py-8 text-center text-slate-400">
                              Tidak ada data siswa pada kelas ini.
                            </td>
                          </tr>
                        ) : (
                          filteredPerClassStudentRows.map((row) => {
                            const dailyEntry = row.dailyEntries[0];
                            return (
                              <tr
                                key={row.student.id}
                                onClick={() => setDetailStudent(row.student)}
                                className="hover:bg-blue-50/50 dark:hover:bg-slate-800/50 cursor-pointer"
                              >
                                <td className="py-3 px-3 font-mono text-slate-500">{row.student.nis}</td>
                                <td className="py-3 px-3 font-bold text-slate-900 dark:text-white">
                                  {row.student.name}
                                </td>
                                {clsPeriod === 'daily' ? (
                                  <>
                                    <td className="py-3 px-3 font-mono">
                                      {dailyEntry?.primaryRecord?.timeIn || '-'}
                                    </td>
                                    <td className="py-3 px-3 text-slate-600 dark:text-slate-300">
                                      {dailyEntry?.primaryRecord?.sessionName || '-'}
                                    </td>
                                    <td className="py-3 px-3">
                                      {dailyEntry ? (
                                        <span
                                          className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${getStudentStatusClass(
                                            dailyEntry.status
                                          )}`}
                                        >
                                          {dailyEntry.status}
                                        </span>
                                      ) : (
                                        <span className="text-slate-400">Belum Tercatat</span>
                                      )}
                                    </td>
                                    <td className="py-3 px-3 text-slate-500">
                                      {dailyEntry?.primaryRecord?.method || '-'}
                                      {dailyEntry?.primaryRecord?.notes
                                        ? ` • ${dailyEntry.primaryRecord.notes}`
                                        : ''}
                                    </td>
                                  </>
                                ) : (
                                  <>
                                    <td className="py-3 px-3 text-center font-bold text-emerald-600">{row.hadir}</td>
                                    <td className="py-3 px-3 text-center font-bold text-amber-600">{row.terlambat}</td>
                                    <td className="py-3 px-3 text-center font-bold text-blue-600">{row.izin}</td>
                                    <td className="py-3 px-3 text-center font-bold text-purple-600">{row.sakit}</td>
                                    <td className="py-3 px-3 text-center font-bold text-red-600">{row.alpa}</td>
                                    <td className="py-3 px-3 text-center font-black text-indigo-600 tabular-nums">
                                      {row.attendanceRate}%
                                    </td>
                                  </>
                                )}
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: RIWAYAT TAMU SEKOLAH */}
      {activeSubTab === 'guest_book' && <GuestBookView showHistory embedded />}

      {/* Student Daily Breakdown Modal */}
      {detailStudent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
          onClick={() => setDetailStudent(null)}
        >
          <div
            className="w-full max-w-lg max-h-[85dvh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-black text-slate-900 dark:text-white">
                  {detailStudent.name}
                </h3>
                <p className="text-xs text-slate-500">
                  NIS: {detailStudent.nis} • Kelas {selectedClassObj?.name || '-'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailStudent(null)}
                className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {(() => {
              const row = perClassComputation.studentRows.find(
                (r) => r.student.id === detailStudent.id
              );
              const entries = row ? row.dailyEntries : [];
              if (entries.length === 0) {
                return (
                  <div className="py-8 text-center text-xs text-slate-400">
                    Belum ada catatan presensi pada rentang periode yang dipilih.
                  </div>
                );
              }
              return (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {entries.map((ent) => (
                    <div key={ent.date} className="py-2.5 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {formatIndoDate(ent.date)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {ent.primaryRecord.sessionName || 'Sesi Harian'} • Masuk{' '}
                          {ent.primaryRecord.timeIn || '-'}
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-bold ${getStudentStatusClass(
                          ent.status
                        )}`}
                      >
                        {ent.status}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
};
