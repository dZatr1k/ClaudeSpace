import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'default' | 'ghost' | 'danger';

const V: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 border border-transparent',
  default: 'bg-elevated text-fg border border-line-strong hover:bg-hover',
  ghost: 'bg-transparent text-fg border border-transparent hover:bg-hover',
  danger: 'bg-st-error text-white border border-transparent hover:brightness-110',
};

export function Button({
  variant = 'default',
  small,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`no-drag inline-flex items-center justify-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none ${small ? 'h-6 px-2 text-[12px]' : 'h-8 px-3 text-[13px]'} ${V[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  title,
  className = '',
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`no-drag inline-flex h-7 min-w-7 items-center justify-center rounded-[6px] px-1.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-40 ${active ? 'bg-selected text-fg' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="tnum rounded border border-line px-1 text-[11px] text-faint">{children}</span>;
}
