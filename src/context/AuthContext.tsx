import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AuthUser } from '../types/index.ts';
import {
  gasPost,
  getStoredSessionUserId,
  setStoredSessionUserId,
  setApiActorName,
} from '../lib/api.ts';
import { hydrateGasConfig, isGasConfigured, subscribeGasConfigChange } from '../lib/gasConfig.ts';

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

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [gasConfigured, setGasConfigured] = useState<boolean>(() => isGasConfigured());
  const idleTimerRef = useRef<number | null>(null);

  const logout = useCallback(() => {
    setStoredSessionUserId(null);
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
    if (!configured) {
      if (userId === BOOTSTRAP_SUPERADMIN_USER.id) {
        setUser(BOOTSTRAP_SUPERADMIN_USER);
        setApiActorName(BOOTSTRAP_SUPERADMIN_USER.username);
      } else if (userId === BOOTSTRAP_ADMIN_USER.id) {
        setUser(BOOTSTRAP_ADMIN_USER);
        setApiActorName(BOOTSTRAP_ADMIN_USER.username);
      } else {
        setUser(null);
      }
      setIsLoading(false);
      return;
    }

    if (!userId) {
      setUser(null);
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
        setUser(res.user as AuthUser);
        setApiActorName((res.user as AuthUser).username || (res.user as AuthUser).name);
      } else if (userId === BOOTSTRAP_SUPERADMIN_USER.id) {
        setUser(BOOTSTRAP_SUPERADMIN_USER);
        setApiActorName(BOOTSTRAP_SUPERADMIN_USER.username);
      } else {
        const errText = String(res.error || '').toLowerCase();
        if (errText.includes('tidak ditemukan') || errText.includes('nonaktif')) {
          logout();
        }
      }
    } catch (err: any) {
      const msg = String(err?.message || '').toLowerCase();
      const isUserInvalid = msg.includes('tidak ditemukan') || msg.includes('nonaktif');
      if (userId === BOOTSTRAP_SUPERADMIN_USER.id) {
        // Keep bootstrap superadmin logged in so Superadmin can inspect/fix URL & Token anytime
        setUser((prev) => prev || BOOTSTRAP_SUPERADMIN_USER);
      } else if (isUserInvalid) {
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

    if (!isGasConfigured()) {
      if (cleanUser.toLowerCase() === 'superadmin' && password === 'superadmin123') {
        setStoredSessionUserId(BOOTSTRAP_SUPERADMIN_USER.id);
        setApiActorName(BOOTSTRAP_SUPERADMIN_USER.username);
        setUser(BOOTSTRAP_SUPERADMIN_USER);
        return { success: true, user: BOOTSTRAP_SUPERADMIN_USER };
      }
      if (cleanUser.toLowerCase() === 'admin' && password === 'admin123') {
        setStoredSessionUserId(BOOTSTRAP_ADMIN_USER.id);
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
        setApiActorName(loggedUser.username || loggedUser.name);
        setUser(loggedUser);
        return { success: true, user: loggedUser };
      }
      return { success: false, error: res.error || 'Username atau password salah.' };
    } catch (err: any) {
      // Allow emergency Superadmin fallback if sheet hasn't been upgraded with usr-superadmin or URL/Token is broken
      if (cleanUser.toLowerCase() === 'superadmin' && password === 'superadmin123') {
        setStoredSessionUserId(BOOTSTRAP_SUPERADMIN_USER.id);
        setApiActorName(BOOTSTRAP_SUPERADMIN_USER.username);
        setUser(BOOTSTRAP_SUPERADMIN_USER);
        return { success: true, user: BOOTSTRAP_SUPERADMIN_USER };
      }
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
