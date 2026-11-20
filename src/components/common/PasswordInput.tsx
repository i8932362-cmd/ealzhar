import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  leftIcon?: React.ReactNode;
  wrapperClassName?: string;
}

/**
 * Reusable password input with integrated Eye / EyeOff visibility toggle.
 */
export const PasswordInput: React.FC<PasswordInputProps> = ({
  leftIcon,
  className = '',
  wrapperClassName = '',
  disabled,
  ...rest
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative w-full ${wrapperClassName}`}>
      {leftIcon && (
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none flex items-center">
          {leftIcon}
        </span>
      )}
      <input
        {...rest}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        className={`w-full ${leftIcon ? 'pl-10' : 'pl-4'} pr-11 py-2.5 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60 ${className}`}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={() => setVisible((prev) => !prev)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition disabled:opacity-50"
        title={visible ? 'Tutup / Sembunyikan Kata Sandi' : 'Lihat Kata Sandi'}
        aria-label={visible ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
};
