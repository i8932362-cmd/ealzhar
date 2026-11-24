import { Student, StudentAttendance, StudentAttendanceStatus } from '../types/index.ts';

export interface MonthWeekSlot {
  weekNumber: number;
  label: string;
  shortRange: string;
  startDate: string;
  endDate: string;
  dates: string[];
}

export interface DailyResolvedEntry {
  studentId: string;
  date: string;
  status: StudentAttendanceStatus;
  primaryRecord: StudentAttendance;
  sessionRecords: StudentAttendance[];
}

export interface DailyAttendanceIndex {
  // date -> studentId -> DailyResolvedEntry
  byDate: Map<string, Map<string, DailyResolvedEntry>>;
  // studentId -> date -> DailyResolvedEntry
  byStudent: Map<string, Map<string, DailyResolvedEntry>>;
  // sorted distinct dates that have at least 1 class record
  activeDates: string[];
}

export interface StudentPeriodTotals {
  student: Student;
  hadir: number;
  terlambat: number;
  izin: number;
  sakit: number;
  alpa: number;
  belumAda: number;
  totalRecorded: number;
  effectiveDays: number;
  attendanceRate: number;
  dailyEntries: DailyResolvedEntry[];
}

export interface PeriodTotalsSummary {
  hadir: number;
  terlambat: number;
  izin: number;
  sakit: number;
  alpa: number;
  totalRecorded: number;
  activeDaysCount: number;
  attendanceRate: number;
}

export interface DailyBreakdownRow {
  date: string;
  dayName: string;
  hadir: number;
  terlambat: number;
  izin: number;
  sakit: number;
  alpa: number;
  belumAda: number;
  totalRecorded: number;
}

export interface MonthBreakdownSummary {
  monthKey: string;
  monthLabel: string;
  totals: PeriodTotalsSummary;
  studentTotalsMap: Map<string, StudentPeriodTotals>;
  dailyBreakdown: DailyBreakdownRow[];
}

const MONTH_NAMES_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

const MONTH_SHORT_ID = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Agu',
  'Sep',
  'Okt',
  'Nov',
  'Des',
];

const DAY_NAMES_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const DAY_SHORT_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

export function isValidIsoDate(s?: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

export function isValidYearMonth(s?: string): boolean {
  return /^\d{4}-\d{2}$/.test(String(s || '').trim());
}

export function shiftIsoDate(dateStr: string, deltaDays: number): string {
  if (!isValidIsoDate(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

export function shiftYearMonth(ymStr: string, deltaMonths: number): string {
  if (!isValidYearMonth(ymStr)) return ymStr;
  const [y, m] = ymStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

export function getMonthBounds(ymStr: string): {
  startDate: string;
  endDate: string;
  daysInMonth: number;
  dates: string[];
} {
  const safeYm = isValidYearMonth(ymStr) ? ymStr : new Date().toISOString().slice(0, 7);
  const [y, m] = safeYm.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dates: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(`${safeYm}-${String(d).padStart(2, '0')}`);
  }
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    daysInMonth,
    dates,
  };
}

/**
 * Splits a calendar month (YYYY-MM) into Monday–Sunday weeks clipped to the month boundaries.
 * Every day of the month belongs to exactly one week, so Sum(Weeks in Month) === Monthly Total.
 */
export function getWeeksInMonth(ymStr: string): MonthWeekSlot[] {
  const { dates } = getMonthBounds(ymStr);
  if (dates.length === 0) return [];
  const monthIdx = Number(ymStr.slice(5, 7)) - 1;
  const monthShort = MONTH_SHORT_ID[monthIdx] || '';

  const weeks: MonthWeekSlot[] = [];
  let currentDates: string[] = [];

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    const [y, m, d] = dateStr.split('-').map(Number);
    const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun, 1=Mon, ...

    if (utcDay === 1 && currentDates.length > 0) {
      weeks.push(buildWeekSlot(weeks.length + 1, currentDates, monthShort));
      currentDates = [];
    }
    currentDates.push(dateStr);
  }
  if (currentDates.length > 0) {
    weeks.push(buildWeekSlot(weeks.length + 1, currentDates, monthShort));
  }
  return weeks;
}

function buildWeekSlot(weekNumber: number, dates: string[], monthShort: string): MonthWeekSlot {
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const dStart = Number(startDate.slice(8, 10));
  const dEnd = Number(endDate.slice(8, 10));
  const shortRange = dStart === dEnd ? `${dStart} ${monthShort}` : `${dStart}–${dEnd} ${monthShort}`;
  return {
    weekNumber,
    label: `Pekan ${weekNumber}`,
    shortRange,
    startDate,
    endDate,
    dates,
  };
}

export function getIndoDayName(dateStr: string): string {
  if (!isValidIsoDate(dateStr)) return '-';
  const [y, m, d] = dateStr.split('-').map(Number);
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return DAY_NAMES_ID[idx] || '-';
}

export function getIndoDayShort(dateStr: string): string {
  if (!isValidIsoDate(dateStr)) return '-';
  const [y, m, d] = dateStr.split('-').map(Number);
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return DAY_SHORT_ID[idx] || '-';
}

export function formatIndoDate(dateStr: string): string {
  if (!isValidIsoDate(dateStr)) return dateStr || '-';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_NAMES_ID[m - 1] || ''} ${y}`;
}

export function formatIndoDateShort(dateStr: string): string {
  if (!isValidIsoDate(dateStr)) return dateStr || '-';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTH_SHORT_ID[m - 1] || ''} ${y}`;
}

export function formatIndoMonth(ymStr: string): string {
  if (!isValidYearMonth(ymStr)) return ymStr || '-';
  const [y, m] = ymStr.split('-').map(Number);
  return `${MONTH_NAMES_ID[m - 1] || ''} ${y}`;
}

export function formatIndoMonthShort(ymStr: string): string {
  if (!isValidYearMonth(ymStr)) return ymStr || '-';
  const [y, m] = ymStr.split('-').map(Number);
  return `${MONTH_SHORT_ID[m - 1] || ''} ${y}`;
}

const STATUS_PRIORITY: Record<StudentAttendanceStatus, number> = {
  Hadir: 5,
  Terlambat: 4,
  Izin: 3,
  Sakit: 2,
  Alpa: 1,
};

function pickCanonicalDailyRecord(records: StudentAttendance[]): StudentAttendance {
  return [...records].sort((a, b) => {
    const pA = STATUS_PRIORITY[a.status] || 0;
    const pB = STATUS_PRIORITY[b.status] || 0;
    if (pA !== pB) return pB - pA;
    return String(a.timeIn || '').localeCompare(String(b.timeIn || ''));
  })[0];
}

/**
 * Merges historical attendance records fetched from Google Sheets (studentRecap)
 * with live real-time todayAttendance from SyncContext, deduplicating cleanly.
 */
export function mergeAttendanceSources(
  historicalRecords: StudentAttendance[],
  liveTodayRecords: StudentAttendance[]
): StudentAttendance[] {
  const byKey = new Map<string, StudentAttendance>();

  const makeCompositeKey = (rec: StudentAttendance) => {
    const d = String(rec.date || '').trim();
    const sid = String(rec.studentId || '').trim();
    const ses = String(rec.sessionId || rec.sessionName || 'default').trim();
    if (rec.id && !rec.id.startsWith('local-')) {
      return `id:${rec.id}`;
    }
    return `comp:${sid}|${d}|${ses}`;
  };

  for (const rec of historicalRecords || []) {
    if (!rec || !rec.studentId || !isValidIsoDate(rec.date)) continue;
    byKey.set(makeCompositeKey(rec), rec);
  }

  // Prefer live todayAttendance updates (reflects latest kiosk scans & manual corrections immediately)
  for (const rec of liveTodayRecords || []) {
    if (!rec || !rec.studentId || !isValidIsoDate(rec.date)) continue;
    const key = makeCompositeKey(rec);
    // Also replace any older entry matching same (studentId, date, sessionId)
    for (const [existingKey, existingVal] of byKey.entries()) {
      if (
        existingVal.studentId === rec.studentId &&
        existingVal.date === rec.date &&
        String(existingVal.sessionId || '') === String(rec.sessionId || '')
      ) {
        byKey.delete(existingKey);
      }
    }
    byKey.set(key, rec);
  }

  return Array.from(byKey.values());
}

/**
 * Builds the single source of truth daily attendance index.
 * Every student has at most 1 resolved DailyResolvedEntry per date,
 * guaranteeing that Weekly, Monthly, and Multi-Month totals equal the sum of Daily records.
 */
export function buildDailyAttendanceIndex(
  records: StudentAttendance[],
  classStudentIds: Set<string>,
  sessionFilter: string = 'ALL'
): DailyAttendanceIndex {
  const byDate = new Map<string, Map<string, DailyResolvedEntry>>();
  const byStudent = new Map<string, Map<string, DailyResolvedEntry>>();
  const grouped = new Map<string, StudentAttendance[]>();

  for (const rec of records) {
    if (!rec || !classStudentIds.has(rec.studentId)) continue;
    if (!isValidIsoDate(rec.date)) continue;
    if (sessionFilter !== 'ALL' && String(rec.sessionId || '') !== sessionFilter) continue;

    const key = `${rec.date}|${rec.studentId}`;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(rec);
    } else {
      grouped.set(key, [rec]);
    }
  }

  const activeDateSet = new Set<string>();

  for (const [key, sessionRecords] of grouped.entries()) {
    const [date, studentId] = key.split('|');
    const sortedSessions = [...sessionRecords].sort((a, b) =>
      String(a.timeIn || '').localeCompare(String(b.timeIn || ''))
    );
    const primaryRecord = pickCanonicalDailyRecord(sortedSessions);
    const entry: DailyResolvedEntry = {
      studentId,
      date,
      status: primaryRecord.status,
      primaryRecord,
      sessionRecords: sortedSessions,
    };

    activeDateSet.add(date);

    let dateMap = byDate.get(date);
    if (!dateMap) {
      dateMap = new Map<string, DailyResolvedEntry>();
      byDate.set(date, dateMap);
    }
    dateMap.set(studentId, entry);

    let studentMap = byStudent.get(studentId);
    if (!studentMap) {
      studentMap = new Map<string, DailyResolvedEntry>();
      byStudent.set(studentId, studentMap);
    }
    studentMap.set(date, entry);
  }

  return {
    byDate,
    byStudent,
    activeDates: Array.from(activeDateSet).sort(),
  };
}

export function computeRecapForDates(
  students: Student[],
  dailyIndex: DailyAttendanceIndex,
  candidateDates: string[]
): {
  totals: PeriodTotalsSummary;
  studentRows: StudentPeriodTotals[];
  dailyBreakdown: DailyBreakdownRow[];
  activeDatesInPeriod: string[];
} {
  const candidateSet = new Set(candidateDates);
  const activeDatesInPeriod = dailyIndex.activeDates.filter((d) => candidateSet.has(d));

  const dailyBreakdown: DailyBreakdownRow[] = activeDatesInPeriod.map((date) => {
    const dateMap = dailyIndex.byDate.get(date);
    let hadir = 0;
    let terlambat = 0;
    let izin = 0;
    let sakit = 0;
    let alpa = 0;
    let belumAda = 0;

    for (const std of students) {
      const entry = dateMap?.get(std.id);
      if (!entry) {
        belumAda++;
      } else if (entry.status === 'Hadir') {
        hadir++;
      } else if (entry.status === 'Terlambat') {
        terlambat++;
      } else if (entry.status === 'Izin') {
        izin++;
      } else if (entry.status === 'Sakit') {
        sakit++;
      } else if (entry.status === 'Alpa') {
        alpa++;
      }
    }

    return {
      date,
      dayName: getIndoDayName(date),
      hadir,
      terlambat,
      izin,
      sakit,
      alpa,
      belumAda,
      totalRecorded: hadir + terlambat + izin + sakit + alpa,
    };
  });

  let sumH = 0;
  let sumT = 0;
  let sumI = 0;
  let sumS = 0;
  let sumA = 0;

  const studentRows: StudentPeriodTotals[] = students.map((student) => {
    const studentMap = dailyIndex.byStudent.get(student.id);
    const dailyEntries: DailyResolvedEntry[] = [];
    let hadir = 0;
    let terlambat = 0;
    let izin = 0;
    let sakit = 0;
    let alpa = 0;

    for (const date of activeDatesInPeriod) {
      const entry = studentMap?.get(date);
      if (!entry) continue;
      dailyEntries.push(entry);
      if (entry.status === 'Hadir') hadir++;
      else if (entry.status === 'Terlambat') terlambat++;
      else if (entry.status === 'Izin') izin++;
      else if (entry.status === 'Sakit') sakit++;
      else if (entry.status === 'Alpa') alpa++;
    }

    sumH += hadir;
    sumT += terlambat;
    sumI += izin;
    sumS += sakit;
    sumA += alpa;

    const totalRecorded = hadir + terlambat + izin + sakit + alpa;
    const effectiveDays = activeDatesInPeriod.length;
    const belumAda = Math.max(0, effectiveDays - totalRecorded);
    const denominator = effectiveDays > 0 ? effectiveDays : totalRecorded;
    const attendanceRate = denominator > 0 ? Math.round(((hadir + terlambat) / denominator) * 100) : 0;

    return {
      student,
      hadir,
      terlambat,
      izin,
      sakit,
      alpa,
      belumAda,
      totalRecorded,
      effectiveDays,
      attendanceRate,
      dailyEntries,
    };
  });

  const totalRecorded = sumH + sumT + sumI + sumS + sumA;
  const maxPossible = students.length * activeDatesInPeriod.length;
  const rateDenom = maxPossible > 0 ? maxPossible : totalRecorded;
  const attendanceRate = rateDenom > 0 ? Math.round(((sumH + sumT) / rateDenom) * 100) : 0;

  return {
    totals: {
      hadir: sumH,
      terlambat: sumT,
      izin: sumI,
      sakit: sumS,
      alpa: sumA,
      totalRecorded,
      activeDaysCount: activeDatesInPeriod.length,
      attendanceRate,
    },
    studentRows,
    dailyBreakdown,
    activeDatesInPeriod,
  };
}

export function computeMonthlyRecap(
  students: Student[],
  dailyIndex: DailyAttendanceIndex,
  ymStr: string
): MonthBreakdownSummary {
  const { dates } = getMonthBounds(ymStr);
  const res = computeRecapForDates(students, dailyIndex, dates);
  const studentTotalsMap = new Map<string, StudentPeriodTotals>();
  for (const row of res.studentRows) {
    studentTotalsMap.set(row.student.id, row);
  }
  return {
    monthKey: ymStr,
    monthLabel: formatIndoMonth(ymStr),
    totals: res.totals,
    studentTotalsMap,
    dailyBreakdown: res.dailyBreakdown,
  };
}

export function computeMultiMonthRecap(
  students: Student[],
  dailyIndex: DailyAttendanceIndex,
  selectedMonths: string[]
): {
  months: MonthBreakdownSummary[];
  combined: ReturnType<typeof computeRecapForDates>;
} {
  const uniqueSortedMonths = Array.from(new Set(selectedMonths.filter(isValidYearMonth))).sort();
  const months = uniqueSortedMonths.map((ym) => computeMonthlyRecap(students, dailyIndex, ym));
  const allDates = uniqueSortedMonths.flatMap((ym) => getMonthBounds(ym).dates);
  const combined = computeRecapForDates(students, dailyIndex, allDates);
  return { months, combined };
}
