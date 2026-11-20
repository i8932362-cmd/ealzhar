import React, { useState, useEffect } from 'react';
import { useSync } from '../../context/SyncContext.tsx';
import { gasGet, gasPost } from '../../lib/api.ts';
import {
  getGasConfig,
  saveAndLockGasConfig,
  unlockGasConfig,
  buildShareableLockedConfigUrl,
  pushGasConfigToServer,
} from '../../lib/gasConfig.ts';
import {
  getCachedSuperadminMeta,
  updateCachedSuperadminPassword,
} from '../../lib/superadminCache.ts';
import { formatWibDateTime24 } from '../../lib/sessions.ts';
import { PasswordInput } from '../common/PasswordInput.tsx';
import { APPS_SCRIPT_CODE, APPS_SCRIPT_DEPLOY_GUIDE } from '../../lib/appsScriptTemplate.ts';
import {
  UserCog,
  Lock,
  Unlock,
  CheckCircle2,
  AlertCircle,
  Copy,
  Share2,
  Database,
  RefreshCw,
  HardDrive,
  FileSpreadsheet,
  Code2,
  BookOpen,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Globe,
  KeyRound,
} from 'lucide-react';

interface SystemCheckResult {
  success: boolean;
  serverTime?: string;
  missingConfig?: string[];
  configuredKeys?: string[];
  sheets?: { ok: boolean; message: string; sheetCount?: number; latencyMs?: number };
  drive?: { ok: boolean; message: string; latencyMs?: number };
}

export const SuperadminDashboard: React.FC = () => {
  const { notifyFaceDatabaseChanged } = useSync();

  const [gasUrl, setGasUrl] = useState('');
  const [gasToken, setGasToken] = useState('');
  const [isLocked, setIsLocked] = useState(false);
  const [fromEnv, setFromEnv] = useState(false);
  const [fromServer, setFromServer] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [systemCheck, setSystemCheck] = useState<SystemCheckResult | null>(null);
  const [provisionResult, setProvisionResult] = useState<{
    spreadsheetName: string;
    spreadsheetUrl: string;
    folderName: string;
    folderUrl: string;
    subfolders?: string[];
  } | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showCodeSection, setShowCodeSection] = useState(false);
  const [showGuideSection, setShowGuideSection] = useState(false);

  // Superadmin Password Cache Management
  const [saMeta, setSaMeta] = useState(() => getCachedSuperadminMeta());
  const [currentSaPass, setCurrentSaPass] = useState('');
  const [newSaPass, setNewSaPass] = useState('');
  const [confirmSaPass, setConfirmSaPass] = useState('');
  const [saPassFeedback, setSaPassFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const reloadConfigState = () => {
    const cfg = getGasConfig();
    setGasUrl(cfg.url);
    setGasToken(cfg.token);
    setIsLocked(cfg.locked);
    setFromEnv(cfg.fromEnv);
    setFromServer(cfg.fromServer);
  };

  useEffect(() => {
    reloadConfigState();
  }, []);

  const copyText = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2200);
    });
  };

  const handleSaveAndLock = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const res = saveAndLockGasConfig(gasUrl, gasToken);
    if (!res.ok) {
      setFeedback({ type: 'error', text: res.error || 'Gagal menyimpan konfigurasi.' });
      return;
    }

    const pushed = await pushGasConfigToServer(gasUrl.trim(), gasToken.trim());
    reloadConfigState();

    try {
      const check = await gasGet<SystemCheckResult>('checkSystem');
      setSystemCheck(check as SystemCheckResult);
      await notifyFaceDatabaseChanged();
      setFeedback({
        type: 'success',
        text: pushed
          ? 'URL & Token berhasil disimpan, dikunci permanen, dan disinkronkan ke server aplikasi. Pengguna lain & Vercel otomatis terhubung!'
          : 'URL & Token berhasil disimpan & dikunci. Gunakan Tautan Akses Terkunci atau Environment Variables Vercel agar semua pengguna lain otomatis terhubung.',
      });
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: `URL & Token sudah disimpan & dikunci, namun uji koneksi ke skrip gagal: ${err?.message || 'Periksa kembali URL/Token dan izin deploy Anyone.'}`,
      });
    }
  };

  const handleUnlock = () => {
    unlockGasConfig();
    reloadConfigState();
    setFeedback({
      type: 'success',
      text: 'Kunci dibuka sementara. Silakan ubah URL/Token lalu klik Simpan & Kunci kembali.',
    });
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setFeedback(null);
    try {
      const check = await gasGet<SystemCheckResult>('checkSystem');
      setSystemCheck(check as SystemCheckResult);
      setFeedback({
        type: 'success',
        text: 'Koneksi Google Apps Script aktif dan merespons normal.',
      });
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err?.message || 'Gagal menguji koneksi ke Google Apps Script.',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleAutoProvision = async () => {
    setIsProvisioning(true);
    setFeedback(null);
    try {
      const res = await gasPost<{
        spreadsheetName: string;
        spreadsheetUrl: string;
        folderName: string;
        folderUrl: string;
        subfolders?: string[];
      }>('setupDatabase', {
        spreadsheetName: 'Database Presensi - Yayasan Mambaul Ulum',
        folderName: 'Database Presensi - Yayasan Mambaul Ulum',
      });
      if (res.success) {
        setProvisionResult({
          spreadsheetName: res.spreadsheetName,
          spreadsheetUrl: res.spreadsheetUrl,
          folderName: res.folderName,
          folderUrl: res.folderUrl,
          subfolders: res.subfolders,
        });
        const check = await gasGet<SystemCheckResult>('checkSystem');
        setSystemCheck(check as SystemCheckResult);
        await notifyFaceDatabaseChanged();
        setFeedback({
          type: 'success',
          text: res.message || 'Spreadsheet & Folder Google Drive siap digunakan!',
        });
      } else {
        setFeedback({ type: 'error', text: res.error || 'Gagal menyiapkan database.' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Gagal menyiapkan database Sheets & Drive.' });
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleChangeSuperadminPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setSaPassFeedback(null);
    if (newSaPass !== confirmSaPass) {
      setSaPassFeedback({ type: 'error', text: 'Konfirmasi sandi baru tidak cocok.' });
      return;
    }
    const res = updateCachedSuperadminPassword(currentSaPass, newSaPass);
    if (res.ok) {
      setSaMeta(getCachedSuperadminMeta());
      setCurrentSaPass('');
      setNewSaPass('');
      setConfirmSaPass('');
      setSaPassFeedback({
        type: 'success',
        text: 'Sandi Superadmin baru berhasil disimpan di cache aplikasi. Admin tidak dapat melihat atau mengubah sandi ini.',
      });
    } else {
      setSaPassFeedback({ type: 'error', text: res.error || 'Gagal memperbarui sandi Superadmin.' });
    }
  };

  const shareableUrl = buildShareableLockedConfigUrl();
  const vercelEnvSnippet = `APPS_SCRIPT_URL=${gasUrl.trim()}\nAPPS_SCRIPT_TOKEN=${gasToken.trim()}\nVITE_APPS_SCRIPT_URL=${gasUrl.trim()}\nVITE_APPS_SCRIPT_TOKEN=${gasToken.trim()}`;

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-5 sm:space-y-6">
      {/* Header Banner */}
      <div className="rounded-3xl bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 p-5 sm:p-8 text-white shadow-xl border border-slate-700/60">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center">
              <UserCog className="w-6 h-6 text-indigo-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-black tracking-tight">Menu Superadmin</h1>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                    isLocked
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-400/40'
                  }`}
                >
                  {isLocked ? 'URL & Token Terkunci' : 'Belum Dikunci'}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                Pengaturan tunggal URL Web App & Token Google Apps Script — cukup tempel sekali untuk semua perangkat & Vercel.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold ${
                systemCheck?.sheets?.ok && systemCheck?.drive?.ok
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
                  : 'bg-white/10 text-slate-200 border border-white/15'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  systemCheck?.sheets?.ok ? 'bg-emerald-400 animate-pulse' : 'bg-indigo-300'
                }`}
              />
              {isLocked ? 'Apps Script Aktif' : 'Menunggu Konfigurasi'}
            </span>
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-4 rounded-2xl border flex items-start gap-3 text-sm ${
            feedback.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Main Form: URL & Token Lock */}
      <div className="rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
              {isLocked ? <Lock className="w-4 h-4 text-emerald-600" /> : <Unlock className="w-4 h-4 text-amber-500" />}
              <span>Koneksi & Penguncian Google Apps Script</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Setelah disimpan & dikunci, Admin, Kepala Sekolah, Guru, dan Kiosk Siswa langsung terhubung tanpa perlu menempel ulang URL atau Token.
            </p>
          </div>

          {isLocked && !fromEnv && (
            <button
              type="button"
              onClick={handleUnlock}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200 border border-amber-200 dark:border-amber-800 transition"
            >
              <Unlock className="w-3.5 h-3.5" />
              <span>Buka Kunci Edit</span>
            </button>
          )}
        </div>

        <form onSubmit={handleSaveAndLock} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
              URL Web App Google Apps Script (<code className="text-[11px]">https://script.google.com/macros/s/.../exec</code>)
            </label>
            <input
              type="url"
              value={gasUrl}
              onChange={(e) => setGasUrl(e.target.value)}
              disabled={isLocked}
              placeholder="https://script.google.com/macros/s/AKfycb.../exec"
              className="w-full px-4 py-2.5 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white disabled:opacity-65 disabled:cursor-not-allowed font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
              Token Rahasia (<code className="text-[11px]">SECRET_TOKEN</code> pada Script Properties)
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={gasToken}
                onChange={(e) => setGasToken(e.target.value)}
                disabled={isLocked}
                placeholder="Masukkan SECRET_TOKEN Anda"
                className="w-full pl-4 pr-12 py-2.5 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white disabled:opacity-65 disabled:cursor-not-allowed font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-2.5 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                title={showToken ? 'Sembunyikan Token' : 'Tampilkan Token'}
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            {!isLocked && (
              <button
                type="submit"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-500/20 transition"
              >
                <Lock className="w-4 h-4" />
                <span>Simpan & Kunci URL + Token</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleTestConnection}
              disabled={isTesting || !gasUrl || !gasToken}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-bold border border-slate-200 dark:border-slate-700 disabled:opacity-50 transition"
            >
              <RefreshCw className={`w-4 h-4 ${isTesting ? 'animate-spin' : ''}`} />
              <span>{isTesting ? 'Menguji Koneksi...' : 'Uji Koneksi Sekarang'}</span>
            </button>

            <button
              type="button"
              onClick={handleAutoProvision}
              disabled={isProvisioning || !gasUrl || !gasToken}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm disabled:opacity-50 transition"
            >
              <Database className={`w-4 h-4 ${isProvisioning ? 'animate-spin' : ''}`} />
              <span>{isProvisioning ? 'Menyiapkan...' : 'Buat / Siapkan Database Sheet & Drive'}</span>
            </button>
          </div>

          {fromServer && (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
              ✓ Konfigurasi tersinkron dengan server (/api/gas-config).
            </p>
          )}
        </form>
      </div>

      {/* System Check & Auto Provision Results */}
      {(systemCheck || provisionResult) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {systemCheck && (
            <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-3">
              <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                <span>Hasil Cek Sheets & Drive</span>
              </h3>
              <div className="space-y-2 text-xs">
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Google Sheets</span>
                  <span className={systemCheck.sheets?.ok ? 'text-emerald-600 font-bold' : 'text-red-600 font-bold'}>
                    {systemCheck.sheets?.message || '-'}
                  </span>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Google Drive</span>
                  <span className={systemCheck.drive?.ok ? 'text-emerald-600 font-bold' : 'text-red-600 font-bold'}>
                    {systemCheck.drive?.message || '-'}
                  </span>
                </div>
                {systemCheck.missingConfig && systemCheck.missingConfig.length > 0 && (
                  <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200">
                    Properti kosong di Script Properties: <strong>{systemCheck.missingConfig.join(', ')}</strong>
                  </div>
                )}
              </div>
            </div>
          )}

          {provisionResult && (
            <div className="rounded-2xl bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900/50 p-5 space-y-3">
              <h3 className="text-sm font-black text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <HardDrive className="w-4 h-4" />
                <span>Database Sheet & Folder Drive Siap</span>
              </h3>
              <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
                <div>
                  Spreadsheet: <strong className="text-slate-900 dark:text-white">{provisionResult.spreadsheetName}</strong>
                </div>
                <div>
                  Folder Drive: <strong className="text-slate-900 dark:text-white">{provisionResult.folderName}</strong>
                </div>
                {provisionResult.subfolders && (
                  <div className="text-[11px] text-slate-500">
                    Subfolder: {provisionResult.subfolders.join(' • ')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vercel & Multi-User Auto-Lock Distribution Card */}
      <div className="rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-black text-slate-900 dark:text-white">
              Kunci Otomatis untuk Semua Pengguna & Vercel
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Agar pengguna lain di perangkat berbeda maupun saat aplikasi di-deploy di Vercel langsung terhubung tanpa menempel URL & Token:
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                <Share2 className="w-3.5 h-3.5 text-blue-600" />
                <span>Opsi 1: Tautan Akses Terkunci (1-Klik)</span>
              </span>
              {shareableUrl && (
                <button
                  type="button"
                  onClick={() => copyText('shareUrl', shareableUrl)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold transition"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedKey === 'shareUrl' ? 'Tersalin!' : 'Salin Tautan'}</span>
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Bagikan tautan ini ke perangkat kiosk/guru/admin lain. Saat dibuka pertama kali, URL & Token langsung tersimpan, terkunci, dan dibersihkan otomatis dari bilah alamat browser.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                <Code2 className="w-3.5 h-3.5 text-indigo-600" />
                <span>Opsi 2: Environment Variables Vercel (Permanen Global)</span>
              </span>
              {gasUrl && gasToken && (
                <button
                  type="button"
                  onClick={() => copyText('vercelEnv', vercelEnvSnippet)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-indigo-600 hover:opacity-90 text-white text-[11px] font-bold transition"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedKey === 'vercelEnv' ? 'Tersalin!' : 'Salin Env Vercel'}</span>
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Tempel di <strong>Vercel → Settings → Environment Variables</strong> (<code>APPS_SCRIPT_URL</code>, <code>APPS_SCRIPT_TOKEN</code>, <code>VITE_APPS_SCRIPT_URL</code>, <code>VITE_APPS_SCRIPT_TOKEN</code>) lalu Redeploy agar setiap pengunjung baru di domain Vercel langsung terkunci otomatis.
            </p>
          </div>
        </div>
      </div>

      {/* Keamanan Sandi Superadmin (Tersimpan di Cache Aplikasi, Terisolasi dari Admin) */}
      <div className="rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-indigo-600" />
              <span>Sandi Superadmin (Cache Aplikasi)</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Sandi Superadmin disimpan aman di cache lokal aplikasi dan tidak dapat dilihat atau diubah oleh Admin.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
            {saMeta.storedInCache ? 'Tersimpan di Cache Aplikasi' : 'Belum Diatur'}
          </span>
        </div>

        {saMeta.updatedAt && (
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            Terakhir diperbarui di cache: <strong>{formatWibDateTime24(saMeta.updatedAt)}</strong>
          </div>
        )}

        {saPassFeedback && (
          <div
            className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
              saPassFeedback.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
            }`}
          >
            {saPassFeedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{saPassFeedback.text}</span>
          </div>
        )}

        <form onSubmit={handleChangeSuperadminPassword} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Sandi Saat Ini
            </label>
            <PasswordInput
              value={currentSaPass}
              onChange={(e) => setCurrentSaPass(e.target.value)}
              placeholder="Sandi Superadmin saat ini"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Sandi Baru (Min 5 karakter)
            </label>
            <PasswordInput
              value={newSaPass}
              onChange={(e) => setNewSaPass(e.target.value)}
              placeholder="Masukkan sandi baru"
              minLength={5}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Ulangi Sandi Baru
            </label>
            <PasswordInput
              value={confirmSaPass}
              onChange={(e) => setConfirmSaPass(e.target.value)}
              placeholder="Ulangi sandi baru"
              minLength={5}
              required
            />
          </div>
          <div className="sm:col-span-3 flex justify-end pt-1">
            <button
              type="submit"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Simpan Sandi Superadmin ke Cache</span>
            </button>
          </div>
        </form>
      </div>

      {/* Collapsible Apps Script Code & Deploy Guide */}
      <div className="rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 sm:p-6 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
            <Code2 className="w-4 h-4 text-blue-600" />
            <span>Kode Google Apps Script (Code.gs) & Petunjuk Deploy</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => copyText('codeGs', APPS_SCRIPT_CODE)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{copiedKey === 'codeGs' ? 'Code.gs Tersalin!' : 'Salin Code.gs'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowCodeSection(!showCodeSection)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              <span>{showCodeSection ? 'Tutup Kode' : 'Lihat Code.gs'}</span>
              {showCodeSection ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => setShowGuideSection(!showGuideSection)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>{showGuideSection ? 'Tutup Panduan' : 'Lihat Petunjuk Deploy'}</span>
            </button>
          </div>
        </div>

        {showCodeSection && (
          <pre className="max-h-96 overflow-auto p-4 rounded-2xl bg-slate-950 text-slate-100 text-[11px] font-mono leading-relaxed">
            {APPS_SCRIPT_CODE}
          </pre>
        )}

        {showGuideSection && (
          <pre className="max-h-96 overflow-auto p-4 rounded-2xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 text-xs whitespace-pre-wrap leading-relaxed">
            {APPS_SCRIPT_DEPLOY_GUIDE}
          </pre>
        )}
      </div>
    </div>
  );
};
