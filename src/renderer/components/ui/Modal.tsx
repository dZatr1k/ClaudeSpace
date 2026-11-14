import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className={`fixed left-1/2 top-[12%] z-50 max-h-[76vh] -translate-x-1/2 overflow-hidden rounded-[8px] border border-line-strong bg-elevated shadow-float flex flex-col ${className}`}
          style={{ width }}
          aria-describedby={undefined}
        >
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-4">
            <Dialog.Title className="text-[15px] font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
              aria-label="Закрыть"
            >
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
          {footer && (
            <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
