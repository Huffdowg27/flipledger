'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';

export interface DateRange {
  preset: string;
  startDate: string;
  endDate: string;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

function getPresetDates(preset: string): { startDate: string; endDate: string } {
  const now = new Date();
  const end = now.toISOString().split('T')[0];
  let start: Date;

  switch (preset) {
    case 'today':
      start = new Date(now); start.setHours(0, 0, 0, 0);
      return { startDate: start.toISOString().split('T')[0], endDate: end };
    case '7d':
      start = new Date(now.getTime() - 7 * 86400000);
      return { startDate: start.toISOString().split('T')[0], endDate: end };
    case '30d':
      start = new Date(now.getTime() - 30 * 86400000);
      return { startDate: start.toISOString().split('T')[0], endDate: end };
    case 'this-month':
      return { startDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, endDate: end };
    case 'last-month': {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      return { startDate: lm.toISOString().split('T')[0], endDate: lmEnd.toISOString().split('T')[0] };
    }
    case 'this-quarter': {
      const q = Math.floor(now.getMonth() / 3) * 3;
      return { startDate: `${now.getFullYear()}-${String(q + 1).padStart(2, '0')}-01`, endDate: end };
    }
    case 'last-quarter': {
      const cq = Math.floor(now.getMonth() / 3);
      const lqStart = new Date(now.getFullYear(), (cq - 1) * 3, 1);
      const lqEnd = new Date(now.getFullYear(), cq * 3, 0);
      return { startDate: lqStart.toISOString().split('T')[0], endDate: lqEnd.toISOString().split('T')[0] };
    }
    case 'ytd':
      return { startDate: `${now.getFullYear()}-01-01`, endDate: end };
    case 'last-year':
      return { startDate: `${now.getFullYear() - 1}-01-01`, endDate: `${now.getFullYear() - 1}-12-31` };
    default:
      start = new Date(now.getTime() - 30 * 86400000);
      return { startDate: start.toISOString().split('T')[0], endDate: end };
  }
}

const presets = [
  { label: 'Today', value: 'today' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'This Month', value: 'this-month' },
  { label: 'Last Month', value: 'last-month' },
  { label: 'This Quarter', value: 'this-quarter' },
  { label: 'Last Quarter', value: 'last-quarter' },
  { label: 'Year to Date', value: 'ytd' },
  { label: 'Last Year', value: 'last-year' },
];

export function createDateRange(preset: string): DateRange {
  const { startDate, endDate } = getPresetDates(preset);
  return { preset, startDate, endDate };
}

export default function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState(value.startDate);
  const [customEnd, setCustomEnd] = useState(value.endDate);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCustom(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const activeLabel = value.preset === 'custom'
    ? `${value.startDate} – ${value.endDate}`
    : presets.find(p => p.value === value.preset)?.label || 'Last 30 days';

  function handlePreset(preset: string) {
    const dates = getPresetDates(preset);
    onChange({ preset, ...dates });
    setOpen(false);
    setShowCustom(false);
  }

  function handleCustomApply() {
    onChange({ preset: 'custom', startDate: customStart, endDate: customEnd });
    setOpen(false);
    setShowCustom(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors"
      >
        <Calendar size={14} className="text-text-tertiary" />
        <span className="max-w-[200px] truncate">{activeLabel}</span>
        <ChevronDown size={14} className="text-text-tertiary" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-bg-elevated border border-border-default rounded-md shadow-lg z-50 py-1 min-w-[200px]">
          {presets.map((preset) => (
            <button
              key={preset.value}
              onClick={() => handlePreset(preset.value)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                value.preset === preset.value
                  ? 'text-accent bg-accent-muted'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {preset.label}
            </button>
          ))}
          <div className="border-t border-border-subtle mt-1 pt-1">
            <button
              onClick={() => setShowCustom(!showCustom)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                value.preset === 'custom'
                  ? 'text-accent bg-accent-muted'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              Custom Range...
            </button>
          </div>
          {showCustom && (
            <div className="px-3 py-2 border-t border-border-subtle space-y-2">
              <div>
                <label className="block text-[11px] font-medium tracking-wide uppercase text-text-tertiary mb-1">Start</label>
                <input
                  type="date"
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  className="w-full h-8 px-2 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium tracking-wide uppercase text-text-tertiary mb-1">End</label>
                <input
                  type="date"
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  className="w-full h-8 px-2 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-accent focus:outline-none"
                />
              </div>
              <button
                onClick={handleCustomApply}
                className="w-full h-8 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors"
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
