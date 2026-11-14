// Context menus (right click / ⋯ button) built from a list of items.
import * as CM from '@radix-ui/react-context-menu';
import * as DM from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}
export type MenuEntry = MenuItem | 'sep';

const itemCls =
  'flex h-7 select-none items-center gap-2 rounded-[4px] px-2 text-[13px] outline-none data-[highlighted]:bg-selected data-[highlighted]:shadow-[inset_0_0_0_1px_var(--border-control)] data-[disabled]:opacity-45';
const contentCls =
  'anim-drop z-50 min-w-[200px] rounded-[10px] border border-line-strong bg-elevated p-1 shadow-pop';

function Items({
  items,
  Item,
  Sep,
}: {
  items: MenuEntry[];
  Item: typeof CM.Item | typeof DM.Item;
  Sep: typeof CM.Separator | typeof DM.Separator;
}) {
  return (
    <>
      {items.map((it, i) =>
        it === 'sep' ? (
          <Sep key={i} className="my-1 h-px bg-line" />
        ) : (
          <Item
            key={i}
            className={`${itemCls} ${it.danger ? 'text-st-error' : ''}`}
            disabled={it.disabled}
            onSelect={() => it.run()}
          >
            <span className={`flex w-4 shrink-0 justify-center ${it.danger ? '' : 'text-muted'}`} aria-hidden>
              {it.icon}
            </span>
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="mono pl-4 text-[11px] text-faint">{it.hint}</span>}
          </Item>
        ),
      )}
    </>
  );
}

export function ContextMenu({
  items,
  children,
}: {
  items: MenuEntry[] | (() => MenuEntry[]);
  children: ReactNode;
}) {
  const list = typeof items === 'function' ? items : () => items;
  return (
    <CM.Root>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={contentCls}>
          <Items items={list()} Item={CM.Item} Sep={CM.Separator} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

export function DropdownMenu({
  items,
  trigger,
  align = 'start',
}: {
  items: MenuEntry[];
  trigger: ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content className={contentCls} align={align} sideOffset={4}>
          <Items items={items} Item={DM.Item} Sep={DM.Separator} />
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
