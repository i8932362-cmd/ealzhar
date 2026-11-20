import React from 'react';
import { normalizeHhMm24 } from '../../lib/sessions.ts';

interface TimeInput24hProps {
  value: string;
  onChange: (nextVal: string) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

/**
 * Strict 24-hour (00:00 - 23:59) time picker using explicit HH and MM selectors.
 * Eliminates browser/OS locale AM/PM formatting completely.
 */
export const TimeInput24h: React.FC<TimeInput24hProps> = ({
  value,
  onChange,
  label,
  disabled = false,
  className = '',
  id,
}) => {
  const normalized = normalizeHhMm24(value, '07:00');
  const [hour, minute] = normalized.split(':');

  const handleHourChange = (nextHour: string) => {
    onChange(`${nextHour}:${minute}`);
  };

  const handleMinuteChange = (nextMin: string) => {
    onChange(`${hour}:${nextMin}`);
  };

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={id}
          className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1"
        >
          {label}
        </label>
      )}
      <div
        id={id}
        className={`inline-flex items-center gap-1.5 px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl w-full ${className}`}
      >
        <select
          aria-label="Jam (00-23)"
          value={hour}
          disabled={disabled}
          onChange={(e) => handleHourChange(e.target.value)}
          className="bg-transparent font-mono font-bold text-xs text-slate-900 dark:text-white focus:outline-none cursor-pointer disabled:opacity-60"
        >
          {HOURS.map((h) => (
            <option key={h} value={h} className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white">
              {h}
            </option>
          ))}
        </select>
        <span className="font-mono font-black text-slate-500 dark:text-slate-400">:</span>
        <select
          aria-label="Menit (00-59)"
          value={minute}
          disabled={disabled}
          onChange={(e) => handleMinuteChange(e.target.value)}
          className="bg-transparent font-mono font-bold text-xs text-slate-900 dark:text-white focus:outline-none cursor-pointer disabled:opacity-60"
        >
          {MINUTES.map((m) => (
            <option key={m} value={m} className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white">
              {m}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-slate-400">
          WIB (24J)
        </span>
      </div>
    </div>
  );
};
