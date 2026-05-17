import { ButtonHTMLAttributes, forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:   'bg-accent text-white hover:bg-accent-hover',
  secondary: 'bg-bg-elevated border border-border-default text-text-primary hover:bg-bg-hover',
  ghost:     'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
  danger:    'bg-negative text-white hover:bg-red-600',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm:   'h-8 px-3 text-xs',
  md:   'h-9 px-3 text-sm',
  icon: 'h-8 w-8 p-0',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors ' +
  'disabled:opacity-60 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-root';

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

export default Button;
