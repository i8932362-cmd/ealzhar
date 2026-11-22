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
  try {
    // Clear legacy persistent localStorage login so every fresh browser session requires username & password
    localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Ignore storage errors
  }
  if (sessionStorage.getItem(LOGOUT_FLAG_KEY) === '1') return null;
  return sessionStorage.getItem(AUTH_SESSION_KEY);
}

export function setStoredSessionUserId(userId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Ignore
  }
  if (userId) {
    sessionStorage.removeItem(LOGOUT_FLAG_KEY);
    sessionStorage.setItem(AUTH_SESSION_KEY, userId);
  } else {
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    sessionStorage.setItem(LOGOUT_FLAG_KEY, '1');
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

async function parseGasJsonResponse<T = any>(res: Response): Promise<ApiResponse<T>> {
  const rawText = await res.text().catch(() => '');
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      success: false,
      transient: true,
      error: `Respon kosong dari Google Apps Script (HTTP ${res.status}).`,
    };
  }
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<')) {
    const needsAuth = /accounts\.google\.com|ServiceLogin|Authorization/i.test(trimmed);
    return {
      success: false,
      transient: !needsAuth && (res.status >= 500 || res.status === 429 || res.status === 200),
      error: needsAuth
        ? 'Google Apps Script meminta otorisasi. Pastikan Deploy Web App diatur: "Execute as: Me" & "Who has access: Anyone".'
        : `Google Apps Script sedang sibuk atau mengembalikan halaman error (HTTP ${res.status}).`,
    };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, transient: true, error: 'Format JSON Google Apps Script tidak valid.' };
    }
    return parsed as ApiResponse<T>;
  } catch {
    return { success: false, transient: true, error: 'Respon Google Apps Script bukan JSON valid.' };
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('Koneksi ke Google Apps Script melebihi batas waktu. Mencoba ulang...');
      (timeoutErr as any).retryable = true;
      (timeoutErr as any).isTimeout = true;
      throw timeoutErr;
    }
    const netErr = new Error(err?.message || 'Gangguan jaringan saat menghubungi Google Apps Script.');
    (netErr as any).retryable = true;
    throw netErr;
  } finally {
    clearTimeout(timer);
  }
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
  const maxAttempts = 2;
  let lastError: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(
        targetUrl,
        { method: 'GET', redirect: 'follow' },
        25000
      );
      const data = await parseGasJsonResponse<T>(res);
      if (!res.ok || data.success === false) {
        const msg = data.error || `Gagal memuat data (${res.status}).`;
        const err = new Error(msg);
        (err as any).retryable =
          Boolean((data as any).transient) ||
          res.status === 429 ||
          res.status >= 500 ||
          isLockContentionMessage(msg);
        throw err;
      }
      return data;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxAttempts - 1 && Boolean(err?.retryable)) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Gagal memuat data dari Google Apps Script.');
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

function isRetryablePostError(err: any): boolean {
  if (!err) return false;
  if (err.conflict || err?.response?.unauthorized) return false;
  if (err.retryable === true || err?.response?.retryable === true || err?.response?.transient === true) {
    return true;
  }
  if (!err.response) {
    // Pure network drop / AbortError / TypeError: Failed to fetch
    return true;
  }
  return isLockContentionMessage(err.message || '');
}

async function executeGasPostOnce<T = any>(
  url: string,
  token: string,
  action: string,
  payload: Record<string, any>
): Promise<ApiResponse<T>> {
  const timeoutMs =
    action === 'bulkImportStudents' || action === 'setupDatabase'
      ? 45000
      : action === 'uploadPhoto'
      ? 35000
      : 25000;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      redirect: 'follow',
      headers: {
        // Wajib text/plain agar Google Apps Script tidak memicu CORS preflight OPTIONS
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({
        ...payload,
        token,
        action,
        actor: payload.actor || currentActorName,
      }),
    },
    timeoutMs
  );

  const data = await parseGasJsonResponse<T>(res);

  if (!res.ok || data.success === false) {
    const msg = data.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    (err as any).conflict = Boolean(data.conflict);
    (err as any).response = data;
    (err as any).retryable =
      !data.conflict &&
      !data.unauthorized &&
      (res.status === 429 ||
        res.status >= 500 ||
        Boolean((data as any).transient) ||
        Boolean((data as any).retryable) ||
        isLockContentionMessage(msg));
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
  const retryDelays = [450, 1100];

  const runRequest = async (): Promise<ApiResponse<T>> => {
    if (trackSaveStatus && !silent) {
      emitSaveState('saving', 'Menyimpan...');
    }

    try {
      let data: ApiResponse<T> | null = null;
      let lastErr: any = null;

      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        try {
          data = await executeGasPostOnce<T>(url, token, action, payload);
          break;
        } catch (err: any) {
          lastErr = err;
          if (attempt < retryDelays.length && isRetryablePostError(err)) {
            if (trackSaveStatus && !silent) {
              emitSaveState('saving', 'Menghubungkan ulang...');
            }
            await new Promise((r) => setTimeout(r, retryDelays[attempt]));
            continue;
          }
          throw err;
        }
      }

      if (!data) {
        throw lastErr || new Error('Gagal menerima respon dari server.');
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
  sessionId?: string;
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
    } catch (e: any) {
      if (
        e?.response &&
        e.response.success === false &&
        !e.response.unauthorized &&
        !isLockContentionMessage(e?.message || '')
      ) {
        await removeOfflineItem(item.id);
      } else {
        console.warn('Failed to replay offline item:', item.id, e);
        failed++;
      }
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

export function primeDrivePhotoCache(fileIdOrUrl: string, dataUrl: string): void {
  const cleanId = extractDriveFileId(fileIdOrUrl) || String(fileIdOrUrl || '').trim();
  if (cleanId && dataUrl) {
    photoCache.set(cleanId, dataUrl);
  }
}

export function invalidateDrivePhotoCache(fileIdOrUrl?: string): void {
  if (!fileIdOrUrl) return;
  const cleanId = extractDriveFileId(fileIdOrUrl) || String(fileIdOrUrl).trim();
  if (cleanId) {
    photoCache.delete(cleanId);
    inflightPhotoRequests.delete(cleanId);
  }
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

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
    reader.readAsDataURL(file);
  });
}

async function optimizeImageFileForDrive(
  file: File,
  maxDimension = 1280
): Promise<{ dataUrl: string; mimeType: string }> {
  const rawDataUrl = await readFileAsDataUrl(file);
  const mime = (file.type || 'image/png').toLowerCase();

  // Keep SVG as-is or small images <= 380 KB untouched so transparency & sharpness stay 100% lossless
  if (mime.includes('svg') || rawDataUrl.length <= 520000) {
    return { dataUrl: rawDataUrl, mimeType: file.type || 'image/png' };
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDimension / Math.max(img.width || 1, img.height || 1));
      const targetW = Math.max(1, Math.round((img.width || maxDimension) * scale));
      const targetH = Math.max(1, Math.round((img.height || maxDimension) * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({ dataUrl: rawDataUrl, mimeType: file.type || 'image/png' });
        return;
      }

      const isPngLike = mime.includes('png') || mime.includes('webp');
      if (!isPngLike) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);

      const outputMime = isPngLike ? 'image/png' : 'image/jpeg';
      let out = canvas.toDataURL(outputMime, 0.9);
      // Fallback to high-quality JPEG if large PNG still > 1.8 MB base64
      if (isPngLike && out.length > 2400000) {
        out = canvas.toDataURL('image/png');
      }
      resolve({ dataUrl: out, mimeType: outputMime });
    };
    img.onerror = () => {
      resolve({ dataUrl: rawDataUrl, mimeType: file.type || 'image/png' });
    };
    img.src = rawDataUrl;
  });
}

export async function uploadImageAssetToDrive(
  file: File,
  options: {
    purpose: 'card_asset' | 'school_logo' | 'logo' | 'signature' | 'watermark' | 'qr' | 'foundation_watermark' | 'foundation_qr';
    fileName?: string;
    previousUrl?: string;
    trashPrevious?: boolean;
  }
): Promise<{
  fileId: string;
  photoUrl: string;
  dataUrl: string;
  fileName?: string;
  folderName?: string;
}> {
  if (!file.type.startsWith('image/')) {
    throw new Error('File yang dipilih harus berupa gambar (PNG, JPG, WebP, atau SVG).');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Ukuran file gambar maksimal 10 MB.');
  }

  const { dataUrl, mimeType } = await optimizeImageFileForDrive(file);
  const previousFileId = extractDriveFileId(options.previousUrl) || undefined;

  const res = await gasPost<{
    fileId: string;
    fileName?: string;
    folderName?: string;
    photoUrl?: string;
  }>('uploadPhoto', {
    base64Data: dataUrl,
    mimeType,
    fileName: options.fileName || file.name,
    purpose: options.purpose,
    previousFileId,
    trashPrevious: Boolean(options.trashPrevious),
  });

  if (!res.success || !res.fileId) {
    throw new Error(res.error || 'Gagal mengunggah gambar ke Google Drive.');
  }

  const photoUrl = res.photoUrl || `gas-photo://${res.fileId}`;
  primeDrivePhotoCache(res.fileId, dataUrl);
  if (options.trashPrevious && previousFileId) {
    invalidateDrivePhotoCache(previousFileId);
  }

  return {
    fileId: res.fileId,
    photoUrl,
    dataUrl,
    fileName: res.fileName,
    folderName: res.folderName,
  };
}

export async function deleteImageAssetFromDrive(fileIdOrUrl?: string): Promise<boolean> {
  if (!fileIdOrUrl) return true;
  const fileId = extractDriveFileId(fileIdOrUrl);
  if (!fileId) return true;
  const res = await gasPost('deletePhoto', { fileId });
  if (res.success) {
    invalidateDrivePhotoCache(fileId);
    return true;
  }
  return false;
}
