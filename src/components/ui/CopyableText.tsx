'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface Props {
  /** Text to display AND copy. */
  text: string;
  /** Optional override for what to copy (defaults to `text`). */
  copyValue?: string;
  /** Visual style of the trigger. Default is inline. */
  variant?: 'inline' | 'chip';
  /** Optional className for the wrapper. */
  className?: string;
  /** Optional title (tooltip). */
  title?: string;
}

/**
 * Click-to-copy text. Used for order IDs, ASINs, FNSKUs, etc. — anything
 * the user might want to paste into a Seller Central form. Shows a brief
 * checkmark + "Copied" affordance for 1.5s after copying.
 */
export default function CopyableText({ text, copyValue, variant = 'inline', className = '', title }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(copyValue ?? text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('Copy failed:', err);
    }
  }

  if (variant === 'chip') {
    return (
      <button
        onClick={handleCopy}
        title={title || `Click to copy: ${text}`}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono bg-bg-elevated border border-border-default hover:border-accent text-text-secondary hover:text-text-primary transition-colors ${className}`}
      >
        <span>{text}</span>
        {copied ? <Check size={10} className="text-positive" /> : <Copy size={10} className="opacity-50" />}
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      title={title || `Click to copy: ${text}`}
      className={`inline-flex items-center gap-1 font-mono hover:text-accent transition-colors group ${className}`}
    >
      <span>{text}</span>
      {copied ? (
        <Check size={11} className="text-positive" />
      ) : (
        <Copy size={11} className="opacity-0 group-hover:opacity-50 transition-opacity" />
      )}
    </button>
  );
}
