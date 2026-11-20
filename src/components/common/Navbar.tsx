import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useSync } from '../../context/SyncContext.tsx';
import { SyncStatusBadge } from './SyncStatusBadge.tsx';
import { PWAInstallButton } from './PWAInstallButton.tsx';
import {
  Maximize,
  Minimize,
  Moon,
  Sun,
  LogOut,
  Shield,
  Layers,
  GraduationCap,
  Briefcase,
  HeartHandshake,
  Menu,
  X,
  LayoutGrid,
  ShieldCheck,
  User,
} from 'lucide-react';

export type ActiveTab =
  | 'portal'
  | 'kiosk'
  | 'homeroom'
  | 'counseling'
  | 'teacher'
  | 'principal'
  | 'admin'
  | 'superadmin';

interface NavbarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenLoginModal: (mode?: 'select' | 'teacher' | 'admin' | 'superadmin') => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  onSelectTab,
  onOpenLoginModal,
  darkMode,
  onToggleDarkMode,
  isFullscreen,
  onToggleFullscreen,
}) => {
  const { user, isAuthenticated, logout } = useAuth();
  const { settings } = useSync();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [accessNotice, setAccessNotice] = useState<string | null>(null);
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const navItems: Array<{
    id: ActiveTab;
    label: string;
    icon: React.ReactNode;
    requiresAuth?: boolean;
    allowedRoles?: string[];
  }> = [
    {
      id: 'portal',
      label: 'Menu Pilihan',
      icon: <LayoutGrid className="w-4 h-4" />,
    },
    {
      id: 'kiosk',
      label: 'Kiosk Siswa',
      icon: <Layers className="w-4 h-4" />,
    },
    {
      id: 'teacher',
      label: 'Presensi Guru',
      icon: <Briefcase className="w-4 h-4" />,
      requiresAuth: true,
      allowedRoles: ['admin', 'guru', 'wali_kelas', 'bk', 'kesiswaan'],
    },
    {
      id: 'homeroom',
      label: 'Wali Kelas',
      icon: <GraduationCap className="w-4 h-4" />,
      requiresAuth: true,
      allowedRoles: ['admin', 'kepala_sekolah', 'wali_kelas'],
    },
    {
      id: 'counseling',
      label: 'BK & Kesiswaan',
      icon: <HeartHandshake className="w-4 h-4" />,
      requiresAuth: true,
      allowedRoles: ['admin', 'kepala_sekolah', 'bk', 'kesiswaan'],
    },
    {
      id: 'principal',
      label: 'Kepala Sekolah',
      icon: <ShieldCheck className="w-4 h-4" />,
      requiresAuth: true,
      allowedRoles: ['kepala_sekolah', 'admin', 'superadmin'],
    },
    {
      id: 'admin',
      label: 'Admin',
      icon: <Shield className="w-4 h-4" />,
      requiresAuth: true,
      allowedRoles: ['admin', 'superadmin'],
    },
    {
      id: 'superadmin',
      label: 'Superadmin',
      icon: <User className="w-4 h-4" />,
      requiresAuth: true,
      allowedRoles: ['superadmin'],
    },
  ];

  const handleTabClick = (item: typeof navItems[0]) => {
    if (item.requiresAuth && !isAuthenticated) {
      onOpenLoginModal(item.id === 'teacher' ? 'teacher' : item.id === 'superadmin' ? 'superadmin' : 'admin');
      return;
    }
    if (item.allowedRoles && user && !item.allowedRoles.includes(user.role)) {
      setAccessNotice(`Akses terbatas: Menu ini hanya untuk peran ${item.allowedRoles.join(', ')}.`);
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = setTimeout(() => setAccessNotice(null), 4000);
      return;
    }
    setAccessNotice(null);
    onSelectTab(item.id);
    setMobileMenuOpen(false);
  };

  const handleSuperadminIconClick = () => {
    if (isAuthenticated && user?.role === 'superadmin') {
      onSelectTab('superadmin');
    } else {
      onOpenLoginModal('superadmin');
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-200/80 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md transition-colors">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14 sm:h-16 gap-2">
          <button
            onClick={() => onSelectTab('portal')}
            className="flex items-center gap-2 sm:gap-3 text-left hover:opacity-90 transition group cursor-pointer min-w-0"
            title="Kembali ke Menu Pilihan Presensi"
          >
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold shadow-md shadow-blue-500/20 flex-shrink-0 group-hover:scale-105 transition-transform">
              <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <div className="min-w-0">
              <span className="text-sm sm:text-base font-bold text-slate-900 dark:text-white tracking-tight line-clamp-1 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition">
                {settings?.schoolName || 'Yayasan Mambaul Ulum'}
              </span>
              <span className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400 block -mt-0.5 truncate">
                Presensi Digital Siswa & Guru
              </span>
            </div>
          </button>

          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              const hasRole = !item.allowedRoles || (user && item.allowedRoles.includes(user.role));
              if (item.id === 'superadmin' && user?.role !== 'superadmin') {
                return null;
              }
              if (item.requiresAuth && isAuthenticated && !hasRole) {
                return null;
              }

              return (
                <button
                  key={item.id}
                  onClick={() => handleTabClick(item)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/25'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <SyncStatusBadge />
            <PWAInstallButton />

            {/* Logo orang kecil untuk Menu Superadmin (pengaturan URL & Token) */}
            <button
              onClick={handleSuperadminIconClick}
              className={`p-1.5 sm:p-2 rounded-xl transition border ${
                activeTab === 'superadmin'
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border-transparent hover:border-slate-200 dark:hover:border-slate-700'
              }`}
              title="Menu Superadmin (Atur & Kunci URL + Token)"
              aria-label="Menu Superadmin"
            >
              <User className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={onToggleFullscreen}
              className="hidden sm:inline-flex p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition"
              title={isFullscreen ? 'Keluar Mode Layar Penuh' : 'Mode Layar Penuh (Kiosk)'}
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>

            <button
              onClick={onToggleDarkMode}
              className="p-1.5 sm:p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition"
              title={darkMode ? 'Mode Terang' : 'Mode Gelap'}
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
            </button>

            {isAuthenticated && user ? (
              <div className="flex items-center gap-1.5 sm:gap-2 pl-1.5 sm:pl-2 border-l border-slate-200 dark:border-slate-800">
                <div className="hidden lg:block text-right">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white line-clamp-1">{user.name}</div>
                  <div className="text-[10px] font-medium text-blue-600 dark:text-blue-400 uppercase tracking-wider">
                    {user.role.replace('_', ' ')}
                  </div>
                </div>
                <button
                  onClick={logout}
                  className="p-1.5 sm:p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl transition"
                  title="Logout"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button
                  onClick={() => onSelectTab('portal')}
                  className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-xl border border-blue-200 dark:border-blue-800 transition"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>Pilihan Presensi</span>
                </button>

                <button
                  onClick={() => onOpenLoginModal('admin')}
                  className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-700 rounded-xl shadow-sm transition"
                >
                  <Shield className="w-3.5 h-3.5" />
                  <span>Login</span>
                </button>
              </div>
            )}

            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl"
              aria-label="Menu navigasi"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 pt-2 pb-4 space-y-1">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            const hasRole = !item.allowedRoles || (user && item.allowedRoles.includes(user.role));
            if (item.id === 'superadmin' && user?.role !== 'superadmin') {
              return null;
            }
            if (item.requiresAuth && isAuthenticated && !hasRole) {
              return null;
            }
            return (
              <button
                key={item.id}
                onClick={() => handleTabClick(item)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {accessNotice && (
        <div className="border-t border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/60 px-4 py-2 text-center text-xs font-semibold text-amber-800 dark:text-amber-200">
          {accessNotice}
        </div>
      )}
    </header>
  );
};
