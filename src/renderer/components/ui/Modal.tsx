import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n/ru';

// Floating layer (DESIGN §5.5): radius 10, --shadow-modal, scrim without blur; opens with a short rise (§5.6),
// closes instantly. Esc and the × close it (Radix).
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 480,
  footer,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-fade fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Content
          className={`anim-rise fixed left-1/2 top-[11%] z-50 flex max-h-[78vh] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-[10px] border border-line-strong bg-elevated shadow-modal ${className}`}
          style={{ width }}
          aria-describedby={undefined}
        >
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 pl-5 pr-3">
            <Dialog.Title className="min-w-0 truncate text-[15px] font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              className="rounded-[6px] p-1.5 text-muted hover:bg-hover hover:text-fg active:bg-selected"
              aria-label={t.actions.close}
            >
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 pt-1">{children}</div>
          {footer && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface/60 px-5 py-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
