import { AttendanceSession, SessionTargetType } from '../types/index.ts';

/**
 * Formats a Date into strict 24-hour WIB (Asia/Jakarta) HH:mm:ss (or HH:mm) string without AM/PM.
 */
export function formatWibTime24(date: Date = new Date(), includeSeconds: boolean = true): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
    const hh = get('hour') === '24' ? '00' : get('hour');
    const formatted = `${hh}:${get('minute')}:${get('second')}`;
    return includeSeconds ? formatted : formatted.slice(0, 5);
  } catch {
    const fallback = date.toTimeString();
    return includeSeconds ? fallback.slice(0, 8) : fallback.slice(0, 5);
  }
}

/**
 * Returns current WIB 24-hour HH:mm string (e.g. "07:15" or "19:45").
 */
export function getWibNowHhMm(date: Date = new Date()): string {
  return formatWibTime24(date).slice(0, 5);
}

/**
 * Formats an ISO string or Date to Indonesian date + strict 24-hour HH:mm:ss WIB (no AM/PM).
 */
export function formatWibDateTime24(input?: string | Date | null): string {
  if (!input) return '-';
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) return String(input);
  const datePart = dt.toLocaleDateString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return `${datePart}, ${formatWibTime24(dt)} WIB`;
}

/**
 * Normalizes any HH:mm string into strict 2-digit 24-hour "HH:mm".
 */
export function normalizeHhMm24(raw?: string | null, fallback = '07:00'): string {
  const str = String(raw || '').trim();
  const m = str.match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return fallback;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return fallback;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function parseHhMmMinutes(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return hh * 60 + mm;
}

/**
 * Checks whether nowHhMm falls within [startTime, endTime] in 24-hour time.
 * Supports both same-day windows (06:00 - 12:00) and overnight windows (22:00 - 05:00).
 */
export function isHhMmInSessionWindow(
  nowHhMm: string,
  startTime: string,
  endTime: string
): boolean {
  const nowMin = parseHhMmMinutes(nowHhMm);
  const startMin = parseHhMmMinutes(startTime);
  const endMin = parseHhMmMinutes(endTime);
  if (nowMin === null || startMin === null || endMin === null) return false;

  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin <= endMin;
  }
  return nowMin >= startMin || nowMin <= endMin;
}

export function sortSessions(sessions: AttendanceSession[]): AttendanceSession[] {
  return [...sessions].sort((a, b) => {
    const orderDiff = (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''));
  });
}

/**
 * Resolves the currently active session for a given targetType ('student' | 'teacher')
 * based on 24-hour WIB time. Automatically transitions as time passes.
 */
export function resolveActiveSessionForType(
  sessions: AttendanceSession[],
  targetType: SessionTargetType,
  nowHhMm: string = getWibNowHhMm()
): AttendanceSession | null {
  const candidates = sortSessions(
    (sessions || []).filter((s) => s.targetType === targetType && s.isActive !== false)
  );
  for (const s of candidates) {
    if (isHhMmInSessionWindow(nowHhMm, s.startTime, s.endTime)) {
      return s;
    }
  }
  return null;
}

/**
 * Finds the next upcoming session later today (or earliest active session) when currently outside session hours.
 */
export function getNextUpcomingSessionForType(
  sessions: AttendanceSession[],
  targetType: SessionTargetType,
  nowHhMm: string = getWibNowHhMm()
): AttendanceSession | null {
  const candidates = sortSessions(
    (sessions || []).filter((s) => s.targetType === targetType && s.isActive !== false)
  );
  if (candidates.length === 0) return null;
  const nowMin = parseHhMmMinutes(nowHhMm);
  if (nowMin === null) return candidates[0];

  const upcomingToday = candidates
    .filter((s) => {
      const st = parseHhMmMinutes(s.startTime);
      return st !== null && st > nowMin;
    })
    .sort((a, b) => (parseHhMmMinutes(a.startTime) ?? 0) - (parseHhMmMinutes(b.startTime) ?? 0));

  return upcomingToday[0] || candidates[0];
}

/**
 * Generates a clean, valid Google Sheet tab name preview for a session.
 */
export function generateSessionSheetName(targetType: SessionTargetType, name: string): string {
  const prefix = targetType === 'teacher' ? 'Presensi_Guru_' : 'Presensi_Siswa_';
  const cleaned = String(name || 'Sesi')
    .replace(/[\\/?*\[\]:]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_');
  return `${prefix}${cleaned || 'Baru'}`.slice(0, 90);
}
