import { getGasConfig, isGasConfigured } from './gasConfig.ts';
import { queueOfflineItem, getOfflineQueue, removeOfflineItem } from './indexedDb.ts';

const AUTH_SESSION_KEY = 'presensi_auth_user_session_v1';
const LOGOUT_FLAG_KEY = 'presensi_tab_logged_out';
const CLIENT_ID_KEY = 'presensi_client_id';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface SaveStateSnapshot {
  status: SaveStatus;
  message: string | null;
  updatedAt: number;
}

let currentSaveState: SaveStateSnapshot = {
  status: 'idle',
  message: null,
  updatedAt: 0,
};
let savedResetTimer: number | null = null;
const saveListeners = new Set<(state: SaveStateSnapshot) => void>();

export function subscribeSaveState(listener: (state: SaveStateSnapshot) => void): () => void {
  saveListeners.add(listener);
  listener(currentSaveState);
  return () => {
    saveListeners.delete(listener);
  };
}

function emitSaveState(status: SaveStatus, message: string | null = null) {
  currentSaveState = { status, message, updatedAt: Date.now() };
  if (typeof window !== 'undefined' && savedResetTimer) {
    window.clearTimeout(savedResetTimer);
    savedResetTimer = null;
  }
  saveListeners.forEach((fn) => fn(currentSaveState));
  if (status === 'saved' && typeof window !== 'undefined') {
    savedResetTimer = window.setTimeout(() => {
      currentSaveState = { status: 'idle', message: null, updatedAt: Date.now() };
      saveListeners.forEach((fn) => fn(currentSaveState));
    }, 2600);
  }
}

export function getRealtimeClientId(): string {
  if (typeof window === 'undefined') return 'ssr-client';
  let id = sessionStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function getWibTodayStr(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Fallback
  }
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return wib.toISOString().split('T')[0];
}

export function getStoredSessionUserId(): string | null {
  if (typeof window === 'undefined') return null;
  const sessionId = sessionStorage.getItem(AUTH_SESSION_KEY);
  if (sessionId) return sessionId;
  if (sessionStorage.getItem(LOGOUT_FLAG_KEY) === '1') return null;
  const legacyLocal = localStorage.getItem(AUTH_SESSION_KEY);
  if (legacyLocal) {
    sessionStorage.setItem(AUTH_SESSION_KEY, legacyLocal);
  }
  return legacyLocal;
}

export function setStoredSessionUserId(userId: string | null): void {
  if (typeof window === 'undefined') return;
  if (userId) {
    sessionStorage.removeItem(LOGOUT_FLAG_KEY);
    sessionStorage.setItem(AUTH_SESSION_KEY, userId);
    if (!localStorage.getItem(AUTH_SESSION_KEY)) {
      localStorage.setItem(AUTH_SESSION_KEY, userId);
    }
  } else {
    const current = sessionStorage.getItem(AUTH_SESSION_KEY);
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    sessionStorage.setItem(LOGOUT_FLAG_KEY, '1');
    if (current && localStorage.getItem(AUTH_SESSION_KEY) === current) {
      localStorage.removeItem(AUTH_SESSION_KEY);
    }
  }
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  conflict?: boolean;
  unauthorized?: boolean;
  [key: string]: any;
}

// Track current actor username for Audit Log sheet ('Log')
let currentActorName = 'system';
export function setApiActorName(actor: string) {
  currentActorName = actor || 'system';
}

export async function gasGet<T = any>(
  action: string,
  params: Record<string, string | number | undefined> = {}
): Promise<ApiResponse<T>> {
  if (!isGasConfigured()) {
    throw new Error('URL & Token Google Apps Script belum diatur.');
  }
  const { url, token } = getGasConfig();
  const query = new URLSearchParams();
  query.set('action', action);
  query.set('token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      query.set(k, String(v));
    }
  }

  const targetUrl = `${url}${url.includes('?') ? '&' : '?'}${query.toString()}`;
  const res = await fetch(targetUrl, {
    method: 'GET',
    redirect: 'follow',
  });
  const data = await res.json().catch(() => ({ success: false, error: 'Respon Google Apps Script bukan JSON valid.' }));
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Gagal memuat data (${res.status}).`);
  }
  return data;
}

const READ_ONLY_POST_ACTIONS = new Set(['login', 'me', 'heartbeat', 'checkSystem']);
let writeMutationTail: Promise<void> = Promise.resolve();

function enqueueWriteMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = writeMutationTail.then(task, task);
  writeMutationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function isLockContentionMessage(msg: string): boolean {
  const lower = (msg || '').toLowerCase();
  return lower.includes('server sedang sibuk') || lower.includes('antrean') || lower.includes('lock');
}

async function executeGasPostOnce<T = any>(
  url: string,
  token: string,
  action: string,
  payload: Record<string, any>
): Promise<ApiResponse<T>> {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      // Wajib text/plain agar Google Apps Script tidak memicu CORS preflight OPTIONS
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify({
      token,
      action,
      actor: payload.actor || currentActorName,
      ...payload,
    }),
  });

  const data = (await res.json().catch(() => ({
    success: false,
    error: 'Respon Google Apps Script bukan JSON valid.',
  }))) as ApiResponse<T>;

  if (!res.ok || data.success === false) {
    const msg = data.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    (err as any).conflict = Boolean(data.conflict);
    (err as any).response = data;
    throw err;
  }

  return data;
}

export async function gasPost<T = any>(
  action: string,
  payload: Record<string, any> = {},
  options: { trackSaveStatus?: boolean; silent?: boolean } = {}
): Promise<ApiResponse<T>> {
  const { trackSaveStatus = true, silent = false } = options;

  if (!isGasConfigured()) {
    const errMsg = 'URL & Token Google Apps Script belum diatur.';
    if (trackSaveStatus && !silent) emitSaveState('error', errMsg);
    throw new Error(errMsg);
  }

  const { url, token } = getGasConfig();
  const isMutating = trackSaveStatus !== false && !READ_ONLY_POST_ACTIONS.has(action);

  const runRequest = async (): Promise<ApiResponse<T>> => {
    if (trackSaveStatus && !silent) {
      emitSaveState('saving', 'Menyimpan...');
    }

    try {
      let data: ApiResponse<T>;
      try {
        data = await executeGasPostOnce<T>(url, token, action, payload);
      } catch (firstErr: any) {
        if (isMutating && isLockContentionMessage(firstErr?.message || '')) {
          await new Promise((r) => setTimeout(r, 250));
          data = await executeGasPostOnce<T>(url, token, action, payload);
        } else {
          throw firstErr;
        }
      }

      if (trackSaveStatus && !silent) {
        emitSaveState('saved', 'Tersimpan');
      }
      return data;
    } catch (err: any) {
      if (trackSaveStatus && !silent) {
        emitSaveState('error', err?.message || 'Gagal menyimpan ke Google Sheets');
      }
      throw err;
    }
  };

  return isMutating ? enqueueWriteMutation(runRequest) : runRequest();
}

// ============================================================================
// 3-SECOND BATCH QUEUE FOR CONSECUTIVE STUDENT SCANS + OFFLINE FALLBACK
// ============================================================================

export interface QueuedStudentScan {
  clientScanId: string;
  studentId: string;
  barcodeCard: string;
  method: string;
  notes?: string;
}

interface PendingBatchEntry {
  scan: QueuedStudentScan;
  resolve: (res: ApiResponse<any>) => void;
  reject: (err: Error) => void;
}

let batchBuffer: PendingBatchEntry[] = [];
let batchTimer: number | null = null;
let isFlushingBatch = false;
const BATCH_INTERVAL_MS = 3000;

async function flushStudentScanBatch(): Promise<void> {
  if (batchTimer && typeof window !== 'undefined') {
    window.clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (isFlushingBatch || batchBuffer.length === 0) return;

  const entries = batchBuffer;
  batchBuffer = [];
  isFlushingBatch = true;

  // If offline at flush time, persist to IndexedDB
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    for (const entry of entries) {
      await queueOfflineItem({
        id: entry.scan.clientScanId,
        type: 'STUDENT_ATTENDANCE',
        payload: entry.scan as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      });
      entry.resolve({
        success: true,
        offline: true,
        message: 'Disimpan di antrian offline (otomatis terkirim saat online).',
      });
    }
    isFlushingBatch = false;
    return;
  }

  try {
    const res = await gasPost('batchStudentAttendance', {
      scans: entries.map((e) => e.scan),
    });

    const resultsList = Array.isArray(res.results) ? res.results : [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const matched =
        resultsList.find((r: any) => r.clientScanId === entry.scan.clientScanId) ||
        resultsList[i] || { success: res.success, error: res.error };
      entry.resolve(matched);
    }
  } catch (err: any) {
    // On network interruption, fall back cleanly to IndexedDB offline queue
    const isNetworkError = !err?.response && typeof navigator !== 'undefined';
    if (isNetworkError) {
      for (const entry of entries) {
        await queueOfflineItem({
          id: entry.scan.clientScanId,
          type: 'STUDENT_ATTENDANCE',
          payload: entry.scan as unknown as Record<string, unknown>,
          createdAt: new Date().toISOString(),
        });
        entry.resolve({
          success: true,
          offline: true,
          message: 'Koneksi terputus: Disimpan di antrian offline.',
        });
      }
    } else {
      for (const entry of entries) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  } finally {
    isFlushingBatch = false;
    if (batchBuffer.length > 0 && typeof window !== 'undefined' && !batchTimer) {
      batchTimer = window.setTimeout(() => {
        void flushStudentScanBatch();
      }, BATCH_INTERVAL_MS);
    }
  }
}

export async function queueStudentScanBatch(scan: Omit<QueuedStudentScan, 'clientScanId'>): Promise<ApiResponse<any>> {
  const fullScan: QueuedStudentScan = {
    ...scan,
    clientScanId: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await queueOfflineItem({
      id: fullScan.clientScanId,
      type: 'STUDENT_ATTENDANCE',
      payload: fullScan as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    });
    return {
      success: true,
      offline: true,
      message: 'Mode Offline: Presensi disimpan sementara & akan dikirim otomatis saat online.',
    };
  }

  emitSaveState('saving', 'Mengantrekan batch (maks 3 detik)...');

  return new Promise<ApiResponse<any>>((resolve, reject) => {
    batchBuffer.push({ scan: fullScan, resolve, reject });
    if (typeof window !== 'undefined' && !batchTimer) {
      batchTimer = window.setTimeout(() => {
        void flushStudentScanBatch();
      }, BATCH_INTERVAL_MS);
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (batchBuffer.length > 0) {
      void flushStudentScanBatch();
    }
  });
}

// ============================================================================
// OFFLINE-AWARE MUTATION HELPER FOR TOILET & MANUAL ATTENDANCE
// ============================================================================

export async function postWithOfflineFallback(
  action: 'toiletStart' | 'toiletReturn' | 'manualStudentAttendance',
  payload: Record<string, any>
): Promise<ApiResponse<any>> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const queueId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await queueOfflineItem({
      id: queueId,
      type: action === 'manualStudentAttendance' ? 'MANUAL_ATTENDANCE' : 'TOILET_PERMIT',
      payload: { action, ...payload },
      createdAt: new Date().toISOString(),
    });
    return {
      success: true,
      offline: true,
      message: 'Disimpan di antrian offline (akan dikirim otomatis saat online).',
    };
  }

  try {
    return await gasPost(action, payload);
  } catch (err: any) {
    if (!err?.response) {
      const queueId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await queueOfflineItem({
        id: queueId,
        type: action === 'manualStudentAttendance' ? 'MANUAL_ATTENDANCE' : 'TOILET_PERMIT',
        payload: { action, ...payload },
        createdAt: new Date().toISOString(),
      });
      return {
        success: true,
        offline: true,
        message: 'Koneksi terputus: Disimpan di antrian offline.',
      };
    }
    throw err;
  }
}

export async function syncOfflineQueue(): Promise<{ synced: number; failed: number }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { synced: 0, failed: 0 };
  }
  if (!isGasConfigured()) {
    return { synced: 0, failed: 0 };
  }

  const queue = await getOfflineQueue();
  if (queue.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  // Group STUDENT_ATTENDANCE items into one batch request
  const studentItems = queue.filter((q) => q.type === 'STUDENT_ATTENDANCE');
  if (studentItems.length > 0) {
    try {
      const res = await gasPost('batchStudentAttendance', {
        scans: studentItems.map((item) => item.payload),
      });
      if (res.success) {
        for (const item of studentItems) {
          await removeOfflineItem(item.id);
          synced++;
        }
      }
    } catch (err) {
      console.warn('Failed to flush offline student batch:', err);
      failed += studentItems.length;
    }
  }

  const otherItems = queue.filter((q) => q.type !== 'STUDENT_ATTENDANCE');
  for (const item of otherItems) {
    try {
      const { action, ...bodyData } = item.payload as { action?: string; [key: string]: any };
      const res = await gasPost(action || 'manualStudentAttendance', bodyData);
      if (res.success) {
        await removeOfflineItem(item.id);
        synced++;
      } else {
        failed++;
      }
    } catch (e) {
      console.warn('Failed to replay offline item:', item.id, e);
      failed++;
    }
  }

  return { synced, failed };
}

// ============================================================================
// PRIVATE GOOGLE DRIVE PHOTO FETCHER & CACHE (No public Drive folder needed)
// ============================================================================

const photoCache = new Map<string, string>();
const inflightPhotoRequests = new Map<string, Promise<string | null>>();

export function extractDriveFileId(photoUrl?: string): string | null {
  if (!photoUrl) return null;
  if (photoUrl.startsWith('gas-photo://')) {
    return photoUrl.replace('gas-photo://', '').trim() || null;
  }
  return null;
}

export async function fetchDrivePhotoDataUrl(fileId: string): Promise<string | null> {
  if (!fileId || !isGasConfigured()) return null;
  const cached = photoCache.get(fileId);
  if (cached) return cached;

  const inflight = inflightPhotoRequests.get(fileId);
  if (inflight) return inflight;

  const promise = gasGet<{ dataUrl: string }>('getPhoto', { fileId })
    .then((res) => {
      if (res.success && res.dataUrl) {
        photoCache.set(fileId, res.dataUrl);
        return res.dataUrl as string;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      inflightPhotoRequests.delete(fileId);
    });

  inflightPhotoRequests.set(fileId, promise);
  return promise;
}
