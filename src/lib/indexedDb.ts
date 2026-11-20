// IndexedDB manager for offline attendance queue

const DB_NAME = 'presensi_offline_db';
const DB_VERSION = 2;
const STORE_NAME = 'offline_queue';
const CONFIG_STORE_NAME = 'gas_config';

export interface OfflineAttendanceItem {
  id: string;
  type: 'STUDENT_ATTENDANCE' | 'TOILET_PERMIT' | 'MANUAL_ATTENDANCE';
  payload: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB not supported'));
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CONFIG_STORE_NAME)) {
        db.createObjectStore(CONFIG_STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePersistedGasConfigIdb(cfg: { url: string; token: string; locked: boolean }): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CONFIG_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CONFIG_STORE_NAME);
      const req = store.put({ key: 'active', ...cfg });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore IDB errors
  }
}

export async function loadPersistedGasConfigIdb(): Promise<{ url: string; token: string; locked: boolean } | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG_STORE_NAME, 'readonly');
      const store = tx.objectStore(CONFIG_STORE_NAME);
      const req = store.get('active');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function queueOfflineItem(item: Omit<OfflineAttendanceItem, 'retryCount'>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const fullItem: OfflineAttendanceItem = { ...item, retryCount: 0 };
    const req = store.put(fullItem);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getOfflineQueue(): Promise<OfflineAttendanceItem[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function removeOfflineItem(id: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('Error removing from offline store:', e);
  }
}

export async function clearOfflineQueue(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('Error clearing offline queue:', e);
  }
}
