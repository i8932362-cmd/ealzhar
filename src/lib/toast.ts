export type ActionToastType = 'saved' | 'deleted' | 'error';

export interface ActionToastPayload {
  id: number;
  type: ActionToastType;
  title?: string;
  message: string;
  durationMs?: number;
}

type ToastListener = (toast: ActionToastPayload | null) => void;

let currentToast: ActionToastPayload | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<ToastListener>();

export function subscribeActionToast(listener: ToastListener): () => void {
  listeners.add(listener);
  listener(currentToast);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissActionToast(): void {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  currentToast = null;
  listeners.forEach((fn) => fn(null));
}

export function emitActionToast(input: {
  type: ActionToastType;
  title?: string;
  message: string;
  durationMs?: number;
}): void {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  const next: ActionToastPayload = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    type: input.type,
    title:
      input.title ||
      (input.type === 'saved'
        ? 'Tersimpan'
        : input.type === 'deleted'
        ? 'Terhapus'
        : 'Gagal'),
    message: input.message,
    durationMs: input.durationMs ?? 3800,
  };

  currentToast = next;
  listeners.forEach((fn) => fn(next));

  if (typeof window !== 'undefined' && next.durationMs && next.durationMs > 0) {
    toastTimer = setTimeout(() => {
      if (currentToast?.id === next.id) {
        currentToast = null;
        listeners.forEach((fn) => fn(null));
      }
    }, next.durationMs);
  }
}
