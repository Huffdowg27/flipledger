'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';

interface YearSelectorProps {
  year: number;
  onChange: (year: number) => void;
}

export default function YearSelector({ year, onChange }: YearSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => currentYear - i);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors"
      >
        <Calendar size={14} className="text-text-tertiary" />
        <span className="font-mono">{year}</span>
        <ChevronDown size={14} className="text-text-tertiary" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-bg-elevated border border-border-default rounded-md shadow-lg z-50 py-1 min-w-[120px]">
          {years.map((y) => (
            <button
              key={y}
              onClick={() => { onChange(y); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm font-mono transition-colors ${
                y === year
                  ? 'text-accent bg-accent-muted'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
