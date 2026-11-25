import React, { useState, useEffect, Suspense, lazy } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { SyncProvider, useSync } from './context/SyncContext.tsx';
import { Navbar, ActiveTab } from './components/common/Navbar.tsx';
import { LoginModal } from './components/common/LoginModal.tsx';
import { GlobalActionToast } from './components/common/GlobalActionToast.tsx';
import { AttendancePortalView } from './components/portal/AttendancePortalView.tsx';
import { AuthUser } from './types/index.ts';

// Code-split heavy views so initial portal loading is instant even on slow mobile networks
const StudentKioskView = lazy(() =>
  import('./components/kiosk/StudentKioskView.tsx').then((m) => ({ default: m.StudentKioskView }))
);
const HomeroomDashboard = lazy(() =>
  import('./components/homeroom/HomeroomDashboard.tsx').then((m) => ({ default: m.HomeroomDashboard }))
);
const CounselingDashboard = lazy(() =>
  import('./components/counseling/CounselingDashboard.tsx').then((m) => ({ default: m.CounselingDashboard }))
);
const TeacherAttendanceView = lazy(() =>
  import('./components/teacher/TeacherAttendanceView.tsx').then((m) => ({ default: m.TeacherAttendanceView }))
);
const PrincipalDashboard = lazy(() =>
  import('./components/principal/PrincipalDashboard.tsx').then((m) => ({ default: m.PrincipalDashboard }))
);
const AdminDashboard = lazy(() =>
  import('./components/admin/AdminDashboard.tsx').then((m) => ({ default: m.AdminDashboard }))
);
const SuperadminDashboard = lazy(() =>
  import('./components/superadmin/SuperadminDashboard.tsx').then((m) => ({ default: m.SuperadminDashboard }))
);
const GuestBookView = lazy(() =>
  import('./components/guest/GuestBookView.tsx').then((m) => ({ default: m.GuestBookView }))
);

const ViewLoadingFallback: React.FC = () => (
  <div className="max-w-3xl mx-auto px-4 py-12 flex flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400">
    <div className="w-7 h-7 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" />
    <span className="text-xs font-semibold">Membuka halaman...</span>
  </div>
);

function MainApp() {
  const { user, isAuthenticated } = useAuth();
  const { syncStatus, offlineQueueCount, reportActiveView } = useSync();

  const [activeTab, setActiveTab] = useState<ActiveTab>('portal');
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [loginInitialMode, setLoginInitialMode] = useState<'select' | 'teacher' | 'admin' | 'superadmin'>('select');

  useEffect(() => {
    reportActiveView(activeTab);
  }, [activeTab, reportActiveView]);

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return (
        localStorage.getItem('theme') === 'dark' ||
        (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)
      );
    }
    return false;
  });
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn('Error attempting to enable fullscreen:', err);
      });
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(console.warn);
    }
  };

  const handleOpenLogin = (mode: 'select' | 'teacher' | 'admin' | 'superadmin' = 'select') => {
    setLoginInitialMode(mode);
    setIsLoginModalOpen(true);
  };

  const handleLoginSuccess = (loggedUser?: AuthUser) => {
    const role = loggedUser?.role;
    if (role === 'superadmin') {
      setActiveTab('superadmin');
    } else if (role === 'kepala_sekolah') {
      setActiveTab('principal');
    } else if (role === 'admin') {
      setActiveTab('admin');
    } else if (role === 'wali_kelas') {
      setActiveTab(loginInitialMode === 'teacher' ? 'teacher' : 'homeroom');
    } else if (role === 'bk' || role === 'kesiswaan') {
      setActiveTab(loginInitialMode === 'teacher' ? 'teacher' : 'counseling');
    } else {
      setActiveTab('teacher');
    }
  };

  return (
    <div className="min-h-dvh w-full overflow-x-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-150">
      <GlobalActionToast />
      <Navbar
        activeTab={activeTab}
        onSelectTab={(tab) => setActiveTab(tab)}
        onOpenLoginModal={(mode) => handleOpenLogin(mode || 'select')}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode(!darkMode)}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
      />

      {/* Mode Switcher Bar — responsive on all mobile screen widths */}
      <div className="bg-white/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-800 py-2 px-3 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5 sm:pb-0">
            <span className="hidden md:inline font-bold text-slate-500 uppercase tracking-wider text-[10px] flex-shrink-0">
              Pilihan Presensi:
            </span>
            <div className="grid grid-cols-2 sm:inline-flex w-full sm:w-auto rounded-xl p-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 gap-1">
              <button
                onClick={() => setActiveTab('portal')}
                className={`flex items-center justify-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg font-bold text-[11px] sm:text-xs transition whitespace-nowrap ${
                  activeTab === 'portal'
                    ? 'bg-slate-900 text-white dark:bg-blue-600 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span>🏠 Menu</span>
              </button>

              <button
                onClick={() => setActiveTab('kiosk')}
                className={`flex items-center justify-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg font-bold text-[11px] sm:text-xs transition whitespace-nowrap ${
                  activeTab === 'kiosk'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-blue-600'
                }`}
              >
                <span>🎓 Siswa</span>
                <span className="hidden sm:inline text-[10px] opacity-75 font-normal">(Kiosk)</span>
              </button>

              <button
                onClick={() => {
                  if (!isAuthenticated) {
                    handleOpenLogin('teacher');
                  } else {
                    setActiveTab('teacher');
                  }
                }}
                className={`flex items-center justify-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg font-bold text-[11px] sm:text-xs transition whitespace-nowrap ${
                  activeTab === 'teacher'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-indigo-600'
                }`}
              >
                <span>👨‍🏫 Guru</span>
                <span className="hidden sm:inline text-[10px] opacity-75 font-normal">(Wajah + GPS)</span>
              </button>

              <button
                onClick={() => setActiveTab('guest')}
                className={`flex items-center justify-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg font-bold text-[11px] sm:text-xs transition whitespace-nowrap ${
                  activeTab === 'guest'
                    ? 'bg-teal-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-teal-600'
                }`}
              >
                <span>📖 Tamu</span>
                <span className="hidden sm:inline text-[10px] opacity-75 font-normal">(TTD Digital)</span>
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-2">
            {!isAuthenticated ? (
              <button
                onClick={() => handleOpenLogin('admin')}
                className="w-full sm:w-auto px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-[11px] sm:text-xs transition flex items-center justify-center gap-1.5 border border-slate-200 dark:border-slate-700"
              >
                <span>🛡️ Login Staf / Kepala Sekolah</span>
              </button>
            ) : (
              <span className="text-[11px] sm:text-xs text-slate-500 truncate">
                Login: <strong>{user?.name}</strong> ({user?.role})
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Offline Alert Banner */}
      {syncStatus === 'offline' && (
        <div className="bg-amber-500 text-white px-4 py-2 text-xs font-medium flex items-center justify-center gap-2 shadow-sm text-center">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse flex-shrink-0" />
          <span>
            Mode Offline Aktif — Presensi disimpan sementara di antrian lokal{' '}
            {offlineQueueCount > 0 ? `(${offlineQueueCount} tersimpan)` : ''} dan otomatis dikirim saat online.
          </span>
        </div>
      )}

      <main className="flex-1 w-full pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <Suspense fallback={<ViewLoadingFallback />}>
          {activeTab === 'portal' && (
            <AttendancePortalView
              onSelectStudentKiosk={() => setActiveTab('kiosk')}
              onSelectTeacherAttendance={() => {
                if (isAuthenticated) {
                  setActiveTab('teacher');
                } else {
                  handleOpenLogin('teacher');
                }
              }}
              onSelectGuestBook={() => setActiveTab('guest')}
              onOpenAdminLogin={() => handleOpenLogin('admin')}
              onOpenTeacherLogin={() => handleOpenLogin('teacher')}
            />
          )}

          {activeTab === 'kiosk' && (
            <StudentKioskView onReturnToPortal={() => setActiveTab('portal')} />
          )}

          {activeTab === 'guest' && (
            <GuestBookView onReturnToPortal={() => setActiveTab('portal')} showHistory={false} />
          )}

          {activeTab === 'homeroom' && (
            isAuthenticated ? (
              <HomeroomDashboard />
            ) : (
              <div className="max-w-md mx-4 sm:mx-auto mt-12 sm:mt-20 text-center p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4 shadow-sm">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Akses Terbatas: Wali Kelas</h3>
                <p className="text-xs text-slate-500">Silakan login menggunakan akun wali kelas untuk melihat data kelas.</p>
                <button
                  onClick={() => handleOpenLogin('admin')}
                  className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition"
                >
                  Login Wali Kelas
                </button>
              </div>
            )
          )}

          {activeTab === 'counseling' && (
            isAuthenticated ? (
              <CounselingDashboard />
            ) : (
              <div className="max-w-md mx-4 sm:mx-auto mt-12 sm:mt-20 text-center p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4 shadow-sm">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Akses Terbatas: BK & Kesiswaan</h3>
                <p className="text-xs text-slate-500">Silakan login menggunakan akun BK / Kesiswaan.</p>
                <button
                  onClick={() => handleOpenLogin('admin')}
                  className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition"
                >
                  Login Petugas
                </button>
              </div>
            )
          )}

          {activeTab === 'teacher' && (
            isAuthenticated ? (
              <TeacherAttendanceView onReturnToPortal={() => setActiveTab('portal')} />
            ) : (
              <div className="max-w-md mx-4 sm:mx-auto mt-12 sm:mt-20 text-center p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4 shadow-sm">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Login Diperlukan</h3>
                <p className="text-xs text-slate-500">Silakan login sebagai guru untuk melakukan presensi masuk & pulang.</p>
                <button
                  onClick={() => handleOpenLogin('teacher')}
                  className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition"
                >
                  Login Guru
                </button>
              </div>
            )
          )}

          {activeTab === 'principal' && (
            isAuthenticated && (user?.role === 'kepala_sekolah' || user?.role === 'admin' || user?.role === 'superadmin') ? (
              <PrincipalDashboard />
            ) : (
              <div className="max-w-md mx-4 sm:mx-auto mt-12 sm:mt-20 text-center p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4 shadow-sm">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Menu Kepala Sekolah</h3>
                <p className="text-xs text-slate-500">Silakan login dengan akun Kepala Sekolah atau Admin untuk membuka Dashboard Kepala Sekolah &amp; Rekap Presensi.</p>
                <button
                  onClick={() => handleOpenLogin('admin')}
                  className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition"
                >
                  Login Kepala Sekolah
                </button>
              </div>
            )
          )}

          {activeTab === 'admin' && (
            isAuthenticated && (user?.role === 'admin' || user?.role === 'superadmin') ? (
              <AdminDashboard />
            ) : (
              <div className="max-w-md mx-4 sm:mx-auto mt-12 sm:mt-20 text-center p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4 shadow-sm">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Akses Administrator</h3>
                <p className="text-xs text-slate-500">Hanya akun dengan peran administrator yang dapat membuka panel ini.</p>
                <button
                  onClick={() => handleOpenLogin('admin')}
                  className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition"
                >
                  Login Admin
                </button>
              </div>
            )
          )}

          {activeTab === 'superadmin' && (
            isAuthenticated && user?.role === 'superadmin' ? (
              <SuperadminDashboard />
            ) : (
              <div className="max-w-md mx-4 sm:mx-auto mt-12 sm:mt-20 text-center p-6 sm:p-8 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-4 shadow-sm">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Menu Superadmin</h3>
                <p className="text-xs text-slate-500">Hanya akun Superadmin yang dapat mengatur & mengunci URL serta Token Google Apps Script.</p>
                <button
                  onClick={() => handleOpenLogin('superadmin')}
                  className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 transition"
                >
                  Login Superadmin
                </button>
              </div>
            )
          )}
        </Suspense>
      </main>

      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        initialMode={loginInitialMode}
        onSelectStudentKiosk={() => setActiveTab('kiosk')}
        onSuccess={handleLoginSuccess}
      />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SyncProvider>
        <MainApp />
      </SyncProvider>
    </AuthProvider>
  );
}
