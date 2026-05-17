import { ReactNode } from 'react';

export type StatusBadgeTone =
  | 'positive'
  | 'warning'
  | 'negative'
  | 'info'
  | 'neutral'
  | 'amazon'
  | 'walmart'
  | 'ebay';

export type StatusBadgeSize = 'xs' | 'sm';

interface StatusBadgeProps {
  tone: StatusBadgeTone;
  size?: StatusBadgeSize;
  className?: string;
  children: ReactNode;
}

const TONE_CLASSES: Record<StatusBadgeTone, string> = {
  positive: 'bg-positive/10 text-positive border-positive/30',
  warning:  'bg-warning/10 text-warning border-warning/30',
  negative: 'bg-negative/10 text-negative border-negative/30',
  info:     'bg-info/10 text-info border-info/30',
  neutral:  'bg-bg-elevated text-text-tertiary border-border-subtle',
  amazon:   'bg-amazon/10 text-amazon border-amazon/30',
  walmart:  'bg-walmart/10 text-walmart border-walmart/30',
  ebay:     'bg-ebay/10 text-ebay border-ebay/30',
};

const SIZE_CLASSES: Record<StatusBadgeSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px]',
  sm: 'px-2 py-0.5 text-xs',
};

export default function StatusBadge({
  tone,
  size = 'sm',
  className = '',
  children,
}: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium border ${TONE_CLASSES[tone]} ${SIZE_CLASSES[size]} ${className}`}
    >
      {children}
    </span>
  );
}
