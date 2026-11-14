import type { ButtonHTMLAttributes, ReactNode } from 'react';

// primary: the one main action of a surface (accent, DESIGN §5.2); default: bordered secondary;
// ghost: toolbar-like; danger: solid red, only inside a confirmation; danger-soft: a destructive action that
// still asks for confirmation (outlined, so it does not shout next to the primary one).
type Variant = 'primary' | 'default' | 'ghost' | 'danger' | 'danger-soft';

const V: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg border border-transparent hover:brightness-110 active:brightness-95 font-semibold',
  default: 'bg-elevated text-fg border border-control hover:bg-hover active:bg-selected',
  ghost: 'bg-transparent text-fg border border-transparent hover:bg-hover active:bg-selected',
  danger: 'bg-st-error text-st-error-fg border border-transparent hover:brightness-110 active:brightness-95',
  'danger-soft':
    'bg-transparent text-st-error border border-st-error/60 hover:bg-st-error/10 active:bg-st-error/20',
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
      className={`no-drag inline-flex items-center justify-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap transition-[background-color,filter] duration-100 disabled:opacity-45 ${small ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]'} ${V[variant]} ${className}`}
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
      aria-pressed={active}
      className={`no-drag inline-flex h-7 min-w-7 items-center justify-center rounded-[6px] px-1.5 text-muted transition-colors duration-100 hover:bg-hover hover:text-fg active:bg-selected disabled:opacity-45 disabled:hover:bg-transparent ${active ? 'bg-selected text-fg' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A key or a shortcut, set in mono (machine value, DESIGN §5.3). */
export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`tnum inline-flex h-[18px] items-center rounded-[4px] border border-line-strong bg-base px-1 font-mono text-[11px] leading-none text-muted ${className}`}
    >
      {children}
    </kbd>
  );
}
