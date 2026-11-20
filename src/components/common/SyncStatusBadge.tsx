import React, { useState, useRef, useEffect } from 'react';
import { useSync } from '../../context/SyncContext.tsx';
import { getRealtimeClientId } from '../../lib/api.ts';
import { Wifi, WifiOff, Users, Radio, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

const TAB_LABELS: Record<string, string> = {
  portal: 'Menu Pilihan',
  kiosk: 'Kiosk Siswa',
  teacher: 'Presensi Guru',
  homeroom: 'Wali Kelas',
  counseling: 'BK & Kesiswaan',
  principal: 'Kepala Sekolah',
  admin: 'Admin Panel',
  superadmin: 'Superadmin',
};

const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  kepala_sekolah: 'Kepala Sekolah',
  guru: 'Guru',
  wali_kelas: 'Wali Kelas',
  bk: 'BK',
  kesiswaan: 'Kesiswaan',
  kiosk: 'Kiosk',
};

export const SyncStatusBadge: React.FC = () => {
  const {
    syncStatus,
    saveStatus,
    saveMessage,
    gasConfigured,
    realtimeConnected,
    activeUsers,
    lastSyncedAt,
    offlineQueueCount,
    syncError,
  } = useSync();

  const [showPopover, setShowPopover] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const myClientId = getRealtimeClientId();

  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopover]);

  return (
    <div ref={containerRef} className="relative flex items-center gap-1.5">
      {/* Live Save State Indicator: Menyimpan... / Tersimpan / Error */}
      {saveStatus === 'saving' && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span className="hidden sm:inline">{saveMessage || 'Menyimpan...'}</span>
        </div>
      )}

      {saveStatus === 'saved' && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{saveMessage || 'Tersimpan'}</span>
        </div>
      )}

      {saveStatus === 'error' && (
        <div
          title={saveMessage || 'Gagal menyimpan data'}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800 max-w-[200px]"
        >
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{saveMessage || 'Gagal menyimpan'}</span>
        </div>
      )}

      {/* Multi-User Automatic Real-Time Status Button (No manual sync button) */}
      <button
        type="button"
        onClick={() => setShowPopover((prev) => !prev)}
        title="Lihat pengguna aktif & status sinkronisasi otomatis"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold border transition-all ${
          !gasConfigured
            ? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
            : syncStatus === 'offline'
            ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
            : syncError
            ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
            : realtimeConnected
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
            : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
        }`}
      >
        {!gasConfigured ? (
          <>
            <AlertCircle className="w-3 h-3 text-slate-500" />
            <span className="hidden sm:inline">Belum Terhubung</span>
          </>
        ) : syncStatus === 'offline' ? (
          <>
            <WifiOff className="w-3 h-3 text-amber-600 dark:text-amber-400" />
            <span>Offline {offlineQueueCount > 0 ? `(${offlineQueueCount})` : ''}</span>
          </>
        ) : (
          <>
            <span className="relative flex h-2 w-2">
              {realtimeConnected && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  syncError ? 'bg-red-500' : realtimeConnected ? 'bg-emerald-500' : 'bg-blue-500'
                }`}
              />
            </span>
            {realtimeConnected ? <Radio className="w-3 h-3" /> : <Wifi className="w-3 h-3" />}
            <span className="hidden sm:inline">{syncError ? 'Gangguan' : 'Real-Time'}</span>
            <span className="inline-flex items-center gap-0.5 pl-1 border-l border-current/25 text-[11px] font-bold">
              <Users className="w-3 h-3" />
              {Math.max(1, activeUsers.length)}
            </span>
          </>
        )}
      </button>

      {showPopover && (
        <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-4 z-50 space-y-3">
          <div className="border-b border-slate-100 dark:border-slate-800 pb-2.5">
            <div className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-blue-600" />
              <span>Pengguna Aktif ({Math.max(1, activeUsers.length)})</span>
            </div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
              Sinkronisasi dua arah berjalan otomatis
              {lastSyncedAt ? ` • ${lastSyncedAt.toLocaleTimeString('id-ID')}` : ''}
            </div>
            {syncError && (
              <div className="mt-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-[10px] text-red-700 dark:text-red-300">
                Error sinkronisasi: {syncError}
              </div>
            )}
          </div>

          <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
            {activeUsers.length === 0 ? (
              <div className="text-[11px] text-slate-400 py-2 text-center">
                Sesi ini aktif (pembaruan otomatis)
              </div>
            ) : (
              activeUsers.map((u) => {
                const isSelf = u.clientId === myClientId;
                return (
                  <div
                    key={u.clientId}
                    className={`p-2 rounded-xl border text-[11px] flex items-center justify-between gap-2 ${
                      isSelf
                        ? 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'
                        : 'bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-slate-900 dark:text-white truncate flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                        <span className="truncate">{u.name}</span>
                        {isSelf && (
                          <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400">(Anda)</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                        {TAB_LABELS[u.activeTab] || u.activeTab} • {u.deviceLabel}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 flex-shrink-0">
                      {ROLE_LABELS[u.role] || u.role}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
