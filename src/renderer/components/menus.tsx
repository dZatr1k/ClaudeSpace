// Context menu entries per entity (DESIGN §2 parity table).
import {
  Archive,
  ArchiveRestore,
  Code,
  Copy,
  Folder,
  GitBranch,
  MessageSquare,
  Pencil,
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import type { Chat, Project, Session, Tab } from '@shared/model';
import * as A from '../actions';
import { t } from '../i18n/ru';
import { useUi } from '../stores/ui';
import type { MenuEntry } from './ui/Menu';

const I = 14;

export function chatMenu(c: Chat): MenuEntry[] {
  if (c.archived)
    return [
      { label: t.actions.restore, icon: <ArchiveRestore size={I} />, run: () => void A.restoreChat(c) },
      { label: t.actions.copyId, icon: <Copy size={I} />, run: () => A.copyText(c.id) },
    ];
  return [
    {
      label: c.open ? t.actions.goTo : t.actions.continue,
      icon: <MessageSquare size={I} />,
      run: () => void A.continueChat(c),
    },
    'sep',
    {
      label: t.actions.archive,
      icon: <Archive size={I} />,
      disabled: !!c.open,
      run: () => void A.archiveChat(c),
    },
    { label: t.actions.rename, icon: <Pencil size={I} />, run: () => A.renameChat(c) },
    { label: t.actions.copyId, icon: <Copy size={I} />, run: () => A.copyText(c.id) },
    ...(c.project
      ? [
          {
            label: t.actions.openProjectFolder,
            icon: <Folder size={I} />,
            run: () => {
              useUi.getState().setLayout({ sidebarTab: 'projects' });
              useUi
                .getState()
                .set({ expanded: { ...useUi.getState().expanded, [c.project as string]: true } });
              useUi.getState().setSelection({ kind: 'project', path: c.project as string });
            },
          } as MenuEntry,
        ]
      : []),
  ];
}

export function projectMenu(p: Project): MenuEntry[] {
  return [
    ...(p.liveSession
      ? [
          {
            label: `${t.actions.goTo}: ${p.liveSession}`,
            icon: <MessageSquare size={I} />,
            run: () => A.openSession(p.liveSession as string),
          } as MenuEntry,
        ]
      : []),
    { label: t.actions.newChat, icon: <Plus size={I} />, run: () => void A.newChat(p.path) },
    { label: t.actions.shell, icon: <SquareTerminal size={I} />, run: () => A.openTemp('shell', p.path) },
    {
      label: t.actions.lazygit,
      icon: <GitBranch size={I} />,
      disabled: !p.git,
      run: () => A.openTemp('lazygit', p.path),
    },
    { label: t.actions.yazi, icon: <Folder size={I} />, run: () => A.openTemp('yazi', p.path) },
    { label: t.actions.vscode, icon: <Code size={I} />, run: () => A.openVsCode(p.path) },
    'sep',
    {
      label: t.actions.createProject,
      icon: <Plus size={I} />,
      run: () => useUi.getState().set({ dialog: { kind: 'createProject' } }),
    },
    {
      label: t.actions.clone,
      icon: <GitBranch size={I} />,
      run: () => useUi.getState().set({ dialog: { kind: 'clone' } }),
    },
  ];
}

export function sessionMenu(s: Session): MenuEntry[] {
  return [
    { label: t.actions.goTo, icon: <SquareTerminal size={I} />, run: () => A.openSession(s.name) },
    { label: t.actions.rename, icon: <Pencil size={I} />, run: () => A.renameSession(s.name) },
    { label: t.actions.detachTab, icon: <X size={I} />, run: () => A.detachSessionTab(s.name) },
    { label: t.actions.copyName, icon: <Copy size={I} />, run: () => A.copyText(s.name) },
    'sep',
    {
      label: t.actions.killSession,
      icon: <Trash2 size={I} />,
      danger: true,
      run: () => A.killSession(s.name),
    },
  ];
}

export function tabMenu(tab: Tab): MenuEntry[] {
  if (tab.kind !== 'tmux' || !tab.session)
    return [{ label: t.actions.closeTab, icon: <X size={I} />, run: () => A.closeTab(tab.id) }];
  const name = tab.session;
  return [
    { label: t.actions.rename, icon: <Pencil size={I} />, run: () => A.renameSession(name) },
    { label: t.actions.detachTab, icon: <X size={I} />, hint: 'Ctrl+Shift+W', run: () => A.closeTab(tab.id) },
    { label: t.actions.copyName, icon: <Copy size={I} />, run: () => A.copyText(name) },
    'sep',
    { label: t.actions.killSession, icon: <Trash2 size={I} />, danger: true, run: () => A.killSession(name) },
  ];
}
