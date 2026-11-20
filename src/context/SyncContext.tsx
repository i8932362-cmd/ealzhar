import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  StudentAttendance,
  ToiletPermit,
  SchoolSettings,
  FaceTemplate,
  Student,
  SchoolClass,
  Teacher,
  SchoolLocation,
  AuditLog,
  FollowUpNote,
  FrequentToiletStudent,
  AttendanceSession,
} from '../types/index.ts';
import {
  gasGet,
  gasPost,
  syncOfflineQueue,
  getRealtimeClientId,
  subscribeSaveState,
  SaveStatus,
} from '../lib/api.ts';
import { hydrateGasConfig, isGasConfigured, subscribeGasConfigChange } from '../lib/gasConfig.ts';
import { getOfflineQueue } from '../lib/indexedDb.ts';
import { getWibNowHhMm, resolveActiveSessionForType, sortSessions } from '../lib/sessions.ts';
import { useAuth } from './AuthContext.tsx';

export type SyncStatus = 'synced' | 'syncing' | 'offline';

export interface ActiveUserPresence {
  clientId: string;
  userId: string;
  username?: string;
  name: string;
  role: string;
  activeTab: string;
  deviceLabel: string;
  lastSeenAt: string;
}

export interface ManagedUserRow {
  id: string;
  username: string;
  name: string;
  role: string;
  email: string;
  classId?: string;
  nip?: string;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  diubah_pada?: string;
  updatedBy?: string;
}

interface SyncContextType {
  syncStatus: SyncStatus;
  saveStatus: SaveStatus;
  saveMessage: string | null;
  gasConfigured: boolean;
  realtimeConnected: boolean;
  serverVersion: number;
  serverDate: string;
  activeUsers: ActiveUserPresence[];
  lastSyncedAt: Date | null;
  faceTemplatesSyncedAt: Date | null;
  syncError: string | null;
  todayAttendance: StudentAttendance[];
  activePermits: ToiletPermit[];
  frequentToiletStudents: FrequentToiletStudent[];
  settings: SchoolSettings | null;
  faceTemplates: FaceTemplate[];
  students: Student[];
  classes: SchoolClass[];
  teachers: Teacher[];
  locations: SchoolLocation[];
  users: ManagedUserRow[];
  auditLogs: AuditLog[];
  followUpNotes: FollowUpNote[];
  sessions: AttendanceSession[];
  activeStudentSession: AttendanceSession | null;
  activeTeacherSession: AttendanceSession | null;
  wibNowHhMm: string;
  offlineQueueCount: number;
  notifyFaceDatabaseChanged: () => Promise<void>;
  updateSettings: (newSettings: Partial<SchoolSettings>) => Promise<boolean>;
  reportActiveView: (activeTab: string) => void;
}

const defaultSettings: SchoolSettings = {
  schoolName: 'Yayasan Mambaul Ulum',
  schoolLogo: '',
  academicYear: '2026/2027',
  checkInTime: '07:00',
  lateCutoffTime: '07:15',
  checkOutTime: '15:00',
  toiletMaxMinutes: 10,
  toiletBabMinutes: 10,
  toiletBakMinutes: 5,
  warningThresholdAbsent: 3,
  warningThresholdLate: 3,
  warningThresholdToilet: 4,
  parentNotificationEnabled: true,
  holidays: [],
  foundationAddress: 'Jl. Pesantren Mambaul Ulum No. 45, Diwek, Jombang, Jawa Timur 61471',
  foundationWebsite: 'https://mambaululum.sch.id',
};

const SYNC_CHANNEL_NAME = 'presensi_mambaul_ulum_gas_sync';
const SYNC_STORAGE_KEY = 'presensi_gas_sync_signal';
const SYNC_SNAPSHOT_CACHE_KEY = 'presensi_sync_snapshot_v1';

interface SyncSnapshotCache {
  settings?: SchoolSettings | null;
  sessions?: AttendanceSession[];
  classes?: SchoolClass[];
  students?: Student[];
  teachers?: Teacher[];
  locations?: SchoolLocation[];
  activePermits?: ToiletPermit[];
  frequentToiletStudents?: FrequentToiletStudent[];
  todayAttendance?: StudentAttendance[];
  serverDate?: string;
}

function readSyncSnapshotCache(): SyncSnapshotCache {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SYNC_SNAPSHOT_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSyncSnapshotCache(snapshot: SyncSnapshotCache): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SYNC_SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore localStorage quota exceeded
  }
}

function detectDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Web Browser';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Web Browser';
}

function normalizeDescriptors(raw: FaceTemplate[]): FaceTemplate[] {
  return (raw || []).map((t) => ({
    ...t,
    descriptor: Array.isArray(t.descriptor)
      ? t.descriptor.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : [],
  }));
}

const SyncContext = createContext<SyncContextType | undefined>(undefined);

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthenticated } = useAuth();
  const initialSnapshotRef = useRef<SyncSnapshotCache | null>(null);
  if (initialSnapshotRef.current === null) {
    initialSnapshotRef.current = readSyncSnapshotCache();
  }
  const snap = initialSnapshotRef.current;

  const [gasConfigured, setGasConfigured] = useState<boolean>(() => isGasConfigured());
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState<boolean>(false);
  const [serverVersion, setServerVersion] = useState<number>(0);
  const [serverDate, setServerDate] = useState<string>(() => snap.serverDate || '');
  const [activeUsers, setActiveUsers] = useState<ActiveUserPresence[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [faceTemplatesSyncedAt, setFaceTemplatesSyncedAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [todayAttendance, setTodayAttendance] = useState<StudentAttendance[]>(() =>
    Array.isArray(snap.todayAttendance) ? snap.todayAttendance : []
  );
  const [activePermits, setActivePermits] = useState<ToiletPermit[]>(() =>
    Array.isArray(snap.activePermits) ? snap.activePermits : []
  );
  const [frequentToiletStudents, setFrequentToiletStudents] = useState<FrequentToiletStudent[]>(() =>
    Array.isArray(snap.frequentToiletStudents) ? snap.frequentToiletStudents : []
  );
  const [settings, setSettings] = useState<SchoolSettings | null>(() => snap.settings || defaultSettings);
  const [faceTemplates, setFaceTemplates] = useState<FaceTemplate[]>([]);
  const [students, setStudents] = useState<Student[]>(() =>
    Array.isArray(snap.students) ? snap.students : []
  );
  const [classes, setClasses] = useState<SchoolClass[]>(() =>
    Array.isArray(snap.classes) ? snap.classes : []
  );
  const [teachers, setTeachers] = useState<Teacher[]>(() =>
    Array.isArray(snap.teachers) ? snap.teachers : []
  );
  const [locations, setLocations] = useState<SchoolLocation[]>(() =>
    Array.isArray(snap.locations) ? snap.locations : []
  );
  const [users, setUsers] = useState<ManagedUserRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [followUpNotes, setFollowUpNotes] = useState<FollowUpNote[]>([]);
  const [sessions, setSessions] = useState<AttendanceSession[]>(() =>
    Array.isArray(snap.sessions) ? sortSessions(snap.sessions) : []
  );
  const [wibNowHhMm, setWibNowHhMm] = useState<string>(() => getWibNowHhMm());
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(0);

  const serverVersionRef = useRef<number>(0);
  const isPollingRef = useRef<boolean>(false);
  const pendingForceRef = useRef<boolean>(false);
  const isTabActiveRef = useRef<boolean>(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const activeTabRef = useRef<string>('portal');
  const userRef = useRef(user);
  userRef.current = user;

  // Keep 24-hour WIB HH:mm clock ticking every 5 seconds for automatic session switching
  useEffect(() => {
    const tick = () => {
      const next = getWibNowHhMm();
      setWibNowHhMm((prev) => (prev === next ? prev : next));
    };
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, []);

  const activeStudentSession = React.useMemo(
    () => resolveActiveSessionForType(sessions, 'student', wibNowHhMm),
    [sessions, wibNowHhMm]
  );

  const activeTeacherSession = React.useMemo(
    () => resolveActiveSessionForType(sessions, 'teacher', wibNowHhMm),
    [sessions, wibNowHhMm]
  );

  // Subscribe to global GAS save status ('idle' | 'saving' | 'saved' | 'error')
  useEffect(() => {
    return subscribeSaveState((snap) => {
      setSaveStatus(snap.status);
      setSaveMessage(snap.message);
    });
  }, []);

  const refreshQueueCount = useCallback(async () => {
    try {
      const q = await getOfflineQueue();
      setOfflineQueueCount(q.length);
    } catch {
      // Ignore IDB errors
    }
  }, []);

  // Core two-way automatic synchronization against Google Apps Script
  const performSync = useCallback(
    async (forceRefresh: boolean = false) => {
      if (!isGasConfigured()) {
        setGasConfigured(false);
        setRealtimeConnected(false);
        return;
      }
      setGasConfigured(true);

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setSyncStatus('offline');
        setRealtimeConnected(false);
        await refreshQueueCount();
        return;
      }

      if (isPollingRef.current) {
        if (forceRefresh) {
          pendingForceRef.current = true;
        }
        return;
      }

      isPollingRef.current = true;
      if (forceRefresh) {
        setSyncStatus('syncing');
      }

      try {
        // Flush any queued offline mutations automatically
        const queue = await getOfflineQueue();
        setOfflineQueueCount(queue.length);
        if (queue.length > 0) {
          const flushed = await syncOfflineQueue();
          const remaining = await getOfflineQueue();
          setOfflineQueueCount(remaining.length);
          if (flushed.synced > 0) {
            forceRefresh = true;
          }
        }

        const curUser = userRef.current;
        const res = await gasGet<{
          hasChanges: boolean;
          serverVersion: number;
          serverTime: string;
          serverDate: string;
          activeUsers?: ActiveUserPresence[];
          settings?: SchoolSettings;
          faceTemplates?: FaceTemplate[];
          classes?: SchoolClass[];
          students?: Student[];
          teachers?: Teacher[];
          locations?: SchoolLocation[];
          todayAttendance?: StudentAttendance[];
          activePermits?: ToiletPermit[];
          frequentToiletStudents?: FrequentToiletStudent[];
          users?: ManagedUserRow[];
          auditLogs?: AuditLog[];
          followUpNotes?: FollowUpNote[];
          sessions?: AttendanceSession[];
          serverHhmm?: string;
        }>('sync', {
          sinceVersion: forceRefresh ? 0 : serverVersionRef.current,
          force: forceRefresh ? '1' : undefined,
          clientId: getRealtimeClientId(),
          userId: curUser?.id || 'guest',
          userName: curUser?.name || 'Perangkat Kiosk',
          userRole: curUser?.role || 'kiosk',
          activeTab: activeTabRef.current,
          deviceLabel: detectDeviceLabel(),
        });

        if (res.success) {
          setSyncError(null);
          setRealtimeConnected(true);
          if (typeof res.serverVersion === 'number') {
            serverVersionRef.current = Math.max(serverVersionRef.current, res.serverVersion);
            setServerVersion(serverVersionRef.current);
          }
          if (res.serverDate) {
            setServerDate(String(res.serverDate));
          }
          if (Array.isArray(res.activeUsers)) {
            setActiveUsers(res.activeUsers);
          }

          if (res.hasChanges !== false) {
            const sortedSessions = Array.isArray(res.sessions) ? sortSessions(res.sessions) : undefined;
            if (res.settings) setSettings(res.settings);
            if (sortedSessions) setSessions(sortedSessions);
            if (Array.isArray(res.faceTemplates)) {
              setFaceTemplates(normalizeDescriptors(res.faceTemplates));
              setFaceTemplatesSyncedAt(new Date());
            }
            if (Array.isArray(res.classes)) setClasses(res.classes);
            if (Array.isArray(res.students)) setStudents(res.students);
            if (Array.isArray(res.teachers)) setTeachers(res.teachers);
            if (Array.isArray(res.locations)) setLocations(res.locations);
            if (Array.isArray(res.todayAttendance)) setTodayAttendance(res.todayAttendance);
            if (Array.isArray(res.activePermits)) setActivePermits(res.activePermits);
            if (Array.isArray(res.frequentToiletStudents)) setFrequentToiletStudents(res.frequentToiletStudents);
            if (Array.isArray(res.users)) setUsers(res.users);
            if (Array.isArray(res.auditLogs)) setAuditLogs(res.auditLogs);
            if (Array.isArray(res.followUpNotes)) setFollowUpNotes(res.followUpNotes);

            const prevSnap = readSyncSnapshotCache();
            writeSyncSnapshotCache({
              settings: res.settings ?? prevSnap.settings,
              sessions: sortedSessions ?? prevSnap.sessions,
              classes: Array.isArray(res.classes) ? res.classes : prevSnap.classes,
              students: Array.isArray(res.students) ? res.students : prevSnap.students,
              teachers: Array.isArray(res.teachers) ? res.teachers : prevSnap.teachers,
              locations: Array.isArray(res.locations) ? res.locations : prevSnap.locations,
              activePermits: Array.isArray(res.activePermits) ? res.activePermits : prevSnap.activePermits,
              frequentToiletStudents: Array.isArray(res.frequentToiletStudents)
                ? res.frequentToiletStudents
                : prevSnap.frequentToiletStudents,
              todayAttendance: Array.isArray(res.todayAttendance) ? res.todayAttendance : prevSnap.todayAttendance,
              serverDate: res.serverDate ? String(res.serverDate) : prevSnap.serverDate,
            });
          }

          setLastSyncedAt(new Date());
          setSyncStatus('synced');
        }
      } catch (err: any) {
        const msg = err?.message || 'Gagal sinkronisasi dengan Google Apps Script';
        setSyncError(msg);
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          setSyncStatus('offline');
          setRealtimeConnected(false);
        } else {
          setSyncStatus('synced');
        }
      } finally {
        isPollingRef.current = false;
        if (pendingForceRef.current) {
          pendingForceRef.current = false;
          void performSync(true);
        }
      }
    },
    [refreshQueueCount]
  );

  // Notify same-browser tabs & immediately reload Sheets state
  const notifyFaceDatabaseChanged = useCallback(async () => {
    try {
      channelRef.current?.postMessage({ type: 'DATA_UPDATED', at: Date.now() });
    } catch {
      // Ignore
    }
    try {
      localStorage.setItem(SYNC_STORAGE_KEY, String(Date.now()));
    } catch {
      // Ignore
    }
    await performSync(true);
  }, [performSync]);

  const reportActiveView = useCallback(
    (activeTab: string) => {
      activeTabRef.current = activeTab;
      if (isGasConfigured() && navigator.onLine) {
        const curUser = userRef.current;
        void gasPost(
          'heartbeat',
          {
            clientId: getRealtimeClientId(),
            userId: curUser?.id || 'guest',
            userName: curUser?.name || 'Perangkat Kiosk',
            userRole: curUser?.role || 'kiosk',
            activeTab,
            deviceLabel: detectDeviceLabel(),
          },
          { trackSaveStatus: false, silent: true }
        ).catch(() => {});
      }
    },
    []
  );

  useEffect(() => {
    reportActiveView(activeTabRef.current);
  }, [user, isAuthenticated, reportActiveView]);

  // Listen to config change, online/offline, visibility, focus, BroadcastChannel, storage
  useEffect(() => {
    const handleOnline = () => {
      setSyncStatus('syncing');
      void performSync(true);
    };
    const handleOffline = () => {
      setSyncStatus('offline');
      setRealtimeConnected(false);
      void refreshQueueCount();
    };
    const handleVisibility = () => {
      const visible = document.visibilityState === 'visible';
      isTabActiveRef.current = visible;
      if (visible) {
        void performSync(true);
      }
    };
    const handleFocus = () => {
      isTabActiveRef.current = true;
      void performSync(true);
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key === SYNC_STORAGE_KEY) {
        void performSync(true);
      }
    };

    const unsubGas = subscribeGasConfigChange(() => {
      serverVersionRef.current = 0;
      setGasConfigured(isGasConfigured());
      if (isGasConfigured()) {
        void performSync(true);
      }
    });

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('storage', handleStorage);

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
        channelRef.current = ch;
        ch.onmessage = (event) => {
          if (event?.data?.type === 'DATA_UPDATED') {
            void performSync(true);
          }
        };
      } catch {
        // Ignore
      }
    }

    return () => {
      unsubGas();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('storage', handleStorage);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [performSync, refreshQueueCount]);

  // Continuous non-overlapping sub-second real-time loop (650ms active, 8s background)
  useEffect(() => {
    let cancelled = false;
    let timerId: number | null = null;

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      timerId = window.setTimeout(async () => {
        if (cancelled) return;
        if (isGasConfigured()) {
          await performSync(false);
        }
        const nextDelay = isTabActiveRef.current ? 650 : 8000;
        scheduleNext(nextDelay);
      }, delayMs);
    };

    void hydrateGasConfig().then((ready) => {
      if (cancelled) return;
      if (ready || isGasConfigured()) {
        setGasConfigured(true);
        void performSync(true).finally(() => scheduleNext(650));
      } else {
        scheduleNext(1500);
      }
    });

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [performSync]);

  const prevSessionKeyRef = useRef<string>('');
  useEffect(() => {
    const nextKey = `${activeStudentSession?.id || ''}|${activeTeacherSession?.id || ''}`;
    if (prevSessionKeyRef.current && prevSessionKeyRef.current !== nextKey && isGasConfigured()) {
      void performSync(true);
    }
    prevSessionKeyRef.current = nextKey;
  }, [activeStudentSession?.id, activeTeacherSession?.id, performSync]);

  const updateSettings = async (newSettings: Partial<SchoolSettings>): Promise<boolean> => {
    try {
      const res = await gasPost<SchoolSettings>('updateSettings', {
        data: {
          ...newSettings,
          expectedUpdatedAt: settings?.diubah_pada,
        },
      });
      if (res.success && res.data) {
        setSettings(res.data);
        await notifyFaceDatabaseChanged();
        return true;
      }
      return false;
    } catch (err: any) {
      setSyncError(err?.message || 'Gagal menyimpan pengaturan');
      throw err;
    }
  };

  return (
    <SyncContext.Provider
      value={{
        syncStatus,
        saveStatus,
        saveMessage,
        gasConfigured,
        realtimeConnected,
        serverVersion,
        serverDate,
        activeUsers,
        lastSyncedAt,
        faceTemplatesSyncedAt,
        syncError,
        todayAttendance,
        activePermits,
        frequentToiletStudents,
        settings,
        faceTemplates,
        students,
        classes,
        teachers,
        locations,
        users,
        auditLogs,
        followUpNotes,
        sessions,
        activeStudentSession,
        activeTeacherSession,
        wibNowHhMm,
        offlineQueueCount,
        notifyFaceDatabaseChanged,
        updateSettings,
        reportActiveView,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
};

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider');
  }
  return context;
}
