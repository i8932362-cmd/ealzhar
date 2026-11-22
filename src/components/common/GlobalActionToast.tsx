import React, { useEffect, useState } from 'react';
import { CheckCircle2, Trash2, AlertCircle, X } from 'lucide-react';
import {
  ActionToastPayload,
  dismissActionToast,
  subscribeActionToast,
} from '../../lib/toast.ts';

export const GlobalActionToast: React.FC = () => {
  const [toast, setToast] = useState<ActionToastPayload | null>(null);

  useEffect(() => {
    return subscribeActionToast(setToast);
  }, []);

  if (!toast) return null;

  const isSaved = toast.type === 'saved';
  const isDeleted = toast.type === 'deleted';

  return (
    <div
      role="status"
      aria-live="assertive"
      className="fixed top-4 left-1/2 -translate-x-1/2 sm:left-auto sm:right-5 sm:translate-x-0 z-[200] w-[calc(100vw-1.5rem)] max-w-md pointer-events-auto animate-in fade-in slide-in-from-top-3 duration-200"
    >
      <div
        className={`flex items-start gap-3 px-4 py-3.5 rounded-2xl shadow-2xl border-2 backdrop-blur-md ${
          isSaved
            ? 'bg-emerald-600/95 text-white border-emerald-300/70'
            : isDeleted
            ? 'bg-rose-600/95 text-white border-rose-300/70'
            : 'bg-red-700/95 text-white border-red-300/70'
        }`}
      >
        <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
          {isSaved ? (
            <CheckCircle2 className="w-5 h-5 text-white" />
          ) : isDeleted ? (
            <Trash2 className="w-5 h-5 text-white" />
          ) : (
            <AlertCircle className="w-5 h-5 text-white" />
          )}
        </div>

        <div className="flex-1 min-w-0 text-xs leading-snug pt-0.5">
          <div className="font-black uppercase tracking-wider text-[11px] flex items-center gap-1.5">
            <span>{toast.title}</span>
            {isDeleted && <CheckCircle2 className="w-3.5 h-3.5 text-white/95" />}
          </div>
          <div className="font-semibold text-white/95 mt-0.5 break-words">{toast.message}</div>
        </div>

        <button
          type="button"
          onClick={dismissActionToast}
          className="p-1 rounded-lg text-white/80 hover:text-white hover:bg-white/15 transition flex-shrink-0"
          title="Tutup notifikasi"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
