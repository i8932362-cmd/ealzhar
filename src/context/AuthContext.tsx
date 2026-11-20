import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AuthUser } from '../types/index.ts';
import {
  gasPost,
  getStoredSessionUserId,
  setStoredSessionUserId,
  setApiActorName,
} from '../lib/api.ts';
import { hydrateGasConfig, isGasConfigured, subscribeGasConfigChange } from '../lib/gasConfig.ts';
import {
  ensureSuperadminCacheSeeded,
  verifyCachedSuperadminPassword,
} from '../lib/superadminCache.ts';

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  gasConfigured: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string; user?: AuthUser }>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000; // 20 menit batas diam
const AUTH_PROFILE_CACHE_KEY = 'presensi_auth_user_profile_v1';

const BOOTSTRAP_SUPERADMIN_USER: AuthUser = {
  id: 'usr-superadmin',
  username: 'superadmin',
  name: 'Superadmin Konfigurasi',
  role: 'superadmin',
  email: 'superadmin@mambaululum.sch.id',
};

const BOOTSTRAP_ADMIN_USER: AuthUser = {
  id: 'usr-admin',
  username: 'admin',
  name: 'Administrator Utama',
  role: 'admin',
  email: 'admin@mambaululum.sch.id',
};

function readCachedUserProfile(expectedUserId: string | null): AuthUser | null {
  if (typeof window === 'undefined' || !expectedUserId) return null;
  try {
    localStorage.removeItem(AUTH_PROFILE_CACHE_KEY);
  } catch {
    // Ignore
  }
  if (expectedUserId === BOOTSTRAP_SUPERADMIN_USER.id) return BOOTSTRAP_SUPERADMIN_USER;
  try {
    const raw = sessionStorage.getItem(AUTH_PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    if (parsed && parsed.id === expectedUserId) return parsed;
  } catch {
    // Ignore
  }
  if (expectedUserId === BOOTSTRAP_ADMIN_USER.id) return BOOTSTRAP_ADMIN_USER;
  return null;
}

function writeCachedUserProfile(profile: AuthUser | null): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(AUTH_PROFILE_CACHE_KEY);
    if (!profile) {
      sessionStorage.removeItem(AUTH_PROFILE_CACHE_KEY);
    } else {
      sessionStorage.setItem(AUTH_PROFILE_CACHE_KEY, JSON.stringify(profile));
    }
  } catch {
    // Ignore storage errors
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const storedId = getStoredSessionUserId();
    return readCachedUserProfile(storedId);
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [gasConfigured, setGasConfigured] = useState<boolean>(() => isGasConfigured());
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    ensureSuperadminCacheSeeded();
  }, []);

  const logout = useCallback(() => {
    setStoredSessionUserId(null);
    writeCachedUserProfile(null);
    setApiActorName('system');
    setUser(null);
  }, []);

  // Sync api actor name with logged-in user
  useEffect(() => {
    if (user) {
      setApiActorName(user.username || user.name || user.id);
    } else {
      setApiActorName('system');
    }
  }, [user]);

  // Idle timer listener
  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
    }
    if (user) {
      idleTimerRef.current = window.setTimeout(() => {
        console.info('Auto-logged out due to inactivity.');
        logout();
      }, INACTIVITY_TIMEOUT_MS);
    }
  }, [user, logout]);

  useEffect(() => {
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((evt) => window.addEventListener(evt, resetIdleTimer));
    resetIdleTimer();

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, resetIdleTimer));
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [resetIdleTimer]);

  const refreshUser = useCallback(async () => {
    const configured = isGasConfigured();
    setGasConfigured(configured);

    const userId = getStoredSessionUserId();
    if (!userId) {
      writeCachedUserProfile(null);
      setUser(null);
      setIsLoading(false);
      return;
    }

    if (userId === BOOTSTRAP_SUPERADMIN_USER.id) {
      setUser(BOOTSTRAP_SUPERADMIN_USER);
      writeCachedUserProfile(BOOTSTRAP_SUPERADMIN_USER);
      setApiActorName(BOOTSTRAP_SUPERADMIN_USER.username);
      setIsLoading(false);
      return;
    }

    if (!configured) {
      if (userId === BOOTSTRAP_ADMIN_USER.id) {
        setUser(BOOTSTRAP_ADMIN_USER);
        writeCachedUserProfile(BOOTSTRAP_ADMIN_USER);
        setApiActorName(BOOTSTRAP_ADMIN_USER.username);
      } else {
        setUser(null);
      }
      setIsLoading(false);
      return;
    }

    try {
      const res = await gasPost<{ user: AuthUser }>(
        'me',
        { userId },
        { trackSaveStatus: false, silent: true }
      );
      if (res.success && res.user) {
        const verifiedUser = res.user as AuthUser;
        setUser(verifiedUser);
        writeCachedUserProfile(verifiedUser);
        setApiActorName(verifiedUser.username || verifiedUser.name);
      } else {
        const errText = String(res.error || '').toLowerCase();
        if (errText.includes('tidak ditemukan') || errText.includes('nonaktif')) {
          logout();
        }
      }
    } catch (err: any) {
      const msg = String(err?.message || '').toLowerCase();
      const isUserInvalid = msg.includes('tidak ditemukan') || msg.includes('nonaktif');
      if (isUserInvalid) {
        logout();
      } else if (userId === BOOTSTRAP_ADMIN_USER.id) {
        setUser((prev) => prev || BOOTSTRAP_ADMIN_USER);
      }
    } finally {
      setIsLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    let active = true;
    void hydrateGasConfig().finally(() => {
      if (active) void refreshUser();
    });
    const unsub = subscribeGasConfigChange(() => {
      setGasConfigured(isGasConfigured());
      void refreshUser();
    });
    return () => {
      active = false;
      unsub();
    };
  }, [refreshUser]);

  const login = async (
    username: string,
    password: string
  ): Promise<{ success: boolean; error?: string; user?: AuthUser }> => {
    const cleanUser = username.trim();

    // Superadmin login selalu diverifikasi dari cache lokal aplikasi, terisolasi dari Admin & Google Sheets Users
    if (cleanUser.toLowerCase() === 'superadmin') {
      if (verifyCachedSuperadminPassword(password)) {
        setStoredSessionUserId(BOOTSTRAP_SUPERADMIN_USER.id);
        writeCachedUserProfile(BOOTSTRAP_SUPERADMIN_USER);
        setApiActorName(BOOTSTRAP_SUPERADMIN_USER.username);
        setUser(BOOTSTRAP_SUPERADMIN_USER);
        return { success: true, user: BOOTSTRAP_SUPERADMIN_USER };
      }
      return {
        success: false,
        error: 'Username atau sandi Superadmin salah.',
      };
    }

    if (!isGasConfigured()) {
      if (cleanUser.toLowerCase() === 'admin' && password === 'admin123') {
        setStoredSessionUserId(BOOTSTRAP_ADMIN_USER.id);
        writeCachedUserProfile(BOOTSTRAP_ADMIN_USER);
        setApiActorName(BOOTSTRAP_ADMIN_USER.username);
        setUser(BOOTSTRAP_ADMIN_USER);
        return { success: true, user: BOOTSTRAP_ADMIN_USER };
      }
      return {
        success: false,
        error: 'URL & Token Google Apps Script belum diatur. Silakan masuk sebagai Superadmin (ikon orang kecil di kanan atas) untuk menempelkannya.',
      };
    }

    try {
      const res = await gasPost<{ user: AuthUser }>(
        'login',
        { username: cleanUser, password },
        { trackSaveStatus: false, silent: true }
      );

      if (res.success && res.user) {
        const loggedUser = res.user as AuthUser;
        setStoredSessionUserId(loggedUser.id);
        writeCachedUserProfile(loggedUser);
        setApiActorName(loggedUser.username || loggedUser.name);
        setUser(loggedUser);
        return { success: true, user: loggedUser };
      }
      return { success: false, error: res.error || 'Username atau password salah.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Gagal terhubung ke Google Apps Script.' };
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        gasConfigured,
        login,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
