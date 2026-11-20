import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext.tsx';
import { AuthUser } from '../../types/index.ts';
import {
  X,
  Lock,
  User,
  AlertCircle,
  KeyRound,
  GraduationCap,
  Briefcase,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
} from 'lucide-react';

export interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectStudentKiosk?: () => void;
  onSuccess?: (user?: AuthUser) => void;
  initialMode?: 'select' | 'teacher' | 'admin' | 'superadmin';
}

export const LoginModal: React.FC<LoginModalProps> = ({
  isOpen,
  onClose,
  onSelectStudentKiosk,
  onSuccess,
  initialMode = 'select',
}) => {
  const { login, gasConfigured } = useAuth();
  const [viewMode, setViewMode] = useState<'select' | 'teacher' | 'admin' | 'superadmin'>(initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  React.useEffect(() => {
    if (isOpen) {
      setViewMode(initialMode);
      setUsername('');
      setPassword('');
      setError(null);
    }
  }, [isOpen, initialMode]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Harap isi username dan password masing-masing.');
      return;
    }

    setIsLoading(true);
    setError(null);

    const res = await login(username.trim(), password);
    setIsLoading(false);

    if (res.success) {
      onClose();
      onSuccess?.(res.user);
    } else {
      setError(res.error || 'Username atau password salah.');
    }
  };

  const handleChooseStudentKiosk = () => {
    onSelectStudentKiosk?.();
    onClose();
  };

  const getModalTitle = () => {
    if (viewMode === 'select') return 'Pilihan Presensi & Login';
    if (viewMode === 'superadmin') return 'Login Superadmin';
    if (viewMode === 'admin') return 'Login Staf, Kepala Sekolah & Admin';
    return 'Login Presensi Guru';
  };

  const getModalSubtitle = () => {
    if (viewMode === 'select') return 'Pilih mode presensi atau login ruang kerja masing-masing';
    if (viewMode === 'superadmin') return 'Atur & kunci URL Web App serta Token Google Apps Script';
    if (viewMode === 'admin') return 'Masuk sesuai akun ke ruang kerja Kepala Sekolah, Admin, Wali Kelas, atau BK';
    return 'Masukkan username & password akun guru Anda untuk masuk ke ruang kerja pribadi';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150 overflow-y-auto">
      <div className="w-full max-w-lg rounded-3xl bg-white dark:bg-slate-900 p-6 sm:p-8 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 duration-150 my-4">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-sm">
              {viewMode === 'superadmin' ? <User className="w-5 h-5" /> : <KeyRound className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">{getModalTitle()}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{getModalSubtitle()}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-xl"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!gasConfigured && (
          <div className="mt-4 p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <span>
              Koneksi Google Apps Script belum diatur. Masuk sebagai <strong>Superadmin</strong> (klik ikon orang kecil di kanan atas navbar) untuk menempelkan & mengunci URL + Token.
            </span>
          </div>
        )}

        {viewMode === 'select' ? (
          <div className="mt-5 space-y-3">
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">Silakan pilih menu:</p>

            <button
              type="button"
              onClick={handleChooseStudentKiosk}
              className="w-full group relative p-4 rounded-2xl border-2 border-blue-200 dark:border-blue-900 hover:border-blue-600 bg-gradient-to-r from-blue-50/50 via-white to-white dark:from-blue-950/20 dark:via-slate-900 dark:to-slate-900 text-left transition-all hover:shadow-md flex items-center justify-between"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold shadow-md shadow-blue-500/20 flex-shrink-0">
                  <GraduationCap className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-black text-sm text-slate-900 dark:text-white group-hover:text-blue-600 transition">
                      Presensi Siswa
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      Tanpa Sandi
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Kiosk layar sentuh deteksi wajah & scan kartu barcode/RFID
                  </p>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-blue-600 group-hover:translate-x-1 transition-transform flex-shrink-0 ml-2" />
            </button>

            <button
              type="button"
              onClick={() => {
                setViewMode('teacher');
                setUsername('');
                setPassword('');
                setError(null);
              }}
              className="w-full group relative p-4 rounded-2xl border-2 border-indigo-200 dark:border-indigo-900 hover:border-indigo-600 bg-gradient-to-r from-indigo-50/50 via-white to-white dark:from-indigo-950/20 dark:via-slate-900 dark:to-slate-900 text-left transition-all hover:shadow-md flex items-center justify-between"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shadow-md shadow-indigo-500/20 flex-shrink-0">
                  <Briefcase className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-black text-sm text-slate-900 dark:text-white group-hover:text-indigo-600 transition">
                      Presensi Guru
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                      Wajah & GPS
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Login dengan akun guru masing-masing untuk presensi & cek riwayat tanggal
                  </p>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-indigo-600 group-hover:translate-x-1 transition-transform flex-shrink-0 ml-2" />
            </button>

            <button
              type="button"
              onClick={() => {
                setViewMode('admin');
                setUsername('');
                setPassword('');
                setError(null);
              }}
              className="w-full group relative p-4 rounded-2xl border-2 border-slate-200 dark:border-slate-800 hover:border-slate-600 bg-gradient-to-r from-slate-50 via-white to-white dark:from-slate-800/40 dark:via-slate-900 dark:to-slate-900 text-left transition-all hover:shadow-md flex items-center justify-between"
            >
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-slate-900 dark:bg-slate-800 text-white flex items-center justify-center font-bold shadow-md flex-shrink-0">
                  <ShieldCheck className="w-6 h-6 text-blue-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-black text-sm text-slate-900 dark:text-white group-hover:text-blue-600 transition">
                      Login Staf, Kepala Sekolah & Admin
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Masuk ke ruang kerja Kepala Sekolah (Cek Sistem), Wali Kelas, BK, atau Admin
                  </p>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-600 group-hover:translate-x-1 transition-transform flex-shrink-0 ml-2" />
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-4 animate-in fade-in">
            {viewMode !== 'superadmin' && (
              <button
                type="button"
                onClick={() => {
                  setViewMode('select');
                  setError(null);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 transition mb-2"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Kembali ke Pilihan Presensi</span>
              </button>
            )}

            {error && (
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 flex items-center gap-2.5 text-xs text-red-700 dark:text-red-300">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Username
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={
                      viewMode === 'superadmin'
                        ? 'superadmin'
                        : viewMode === 'teacher'
                          ? 'Masukkan username guru Anda'
                          : 'Masukkan username Anda'
                    }
                    autoFocus
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Masukkan kata sandi"
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="mt-2 w-full py-3 px-4 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-500/20 disabled:opacity-50 transition flex items-center justify-center gap-2"
              >
                {isLoading && (
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                )}
                {viewMode === 'superadmin'
                  ? 'Masuk ke Menu Superadmin'
                  : viewMode === 'admin'
                    ? 'Masuk ke Ruang Kerja'
                    : 'Masuk ke Ruang Kerja Guru'}
              </button>
            </form>

            {viewMode === 'superadmin' ? (
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-center text-[11px] text-slate-500 dark:text-slate-400">
                Akun default Superadmin: <strong>superadmin</strong> / <strong>superadmin123</strong>
              </div>
            ) : (
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-center text-[11px] text-slate-500 dark:text-slate-400">
                Gunakan username &amp; password masing-masing yang telah terdaftar di Admin untuk masuk langsung ke ruang kerja Anda.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
