import { useEffect, useRef, useState } from 'react';
import { appShortcut } from './keymap';
import { runAppCommand } from './commands';
import { useConn } from './stores/conn';
import { useData } from './stores/data';
import { useTabs } from './stores/tabs';
import { useUi } from './stores/ui';
import { TitleBar } from './components/TitleBar/TitleBar';
import { Sidebar } from './components/Sidebar/Sidebar';
import { RightPanel } from './components/RightPanel/RightPanel';
import { StatusBar } from './components/StatusBar/StatusBar';
import { StartScreen } from './components/Terminal/StartScreen';
import { TerminalStack } from './components/Terminal/TerminalView';
import { Palette } from './components/Palette/Palette';
import { SystemView } from './components/Overlays/SystemView';
import { SettingsOverlay } from './components/Overlays/Settings';
import { ConnectScreen } from './components/Overlays/ConnectScreen';
import { Dialogs, Toasts } from './components/Overlays/Dialogs';
import { AskpassDialog } from './components/Overlays/AskpassDialog';
import { ChatSearch } from './components/Overlays/ChatSearch';
import { UpdateNotice } from './components/Overlays/UpdateNotice';

function Splitter({ side, onDrag }: { side: 'left' | 'right'; onDrag: (dx: number) => void }) {
  const start = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-line after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] hover:bg-accent"
      onPointerDown={(e) => {
        start.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        const dx = e.clientX - start.current;
        start.current = e.clientX;
        onDrag(side === 'left' ? dx : -dx);
      }}
      onPointerUp={() => (start.current = null)}
    />
  );
}

/** Show the connection screen only when the user has to do something, or on the very first start. */
function useShowConnect(): boolean {
  const s = useConn((c) => c.state);
  const ever = useConn((c) => c.everOnline);
  const hasData = useData((d) => d.projects.length > 0 || Object.keys(d.chats).length > 0);
  if (s.kind === 'needs-user') return true;
  if (!ever && !hasData && (s.kind === 'connecting' || s.kind === 'offline' || s.kind === 'idle'))
    return true;
  return false;
}

export function App() {
  const layout = useUi((u) => u.layout);
  const tabsCount = useTabs((s) => s.tabs.length);
  const showConnect = useShowConnect();
  const [narrow, setNarrow] = useState(window.innerWidth < 1200);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1200);
    window.addEventListener('resize', onResize);
    const onKey = (e: KeyboardEvent) => {
      const inTerm = !!(e.target as HTMLElement | null)?.closest?.('.xterm');
      if (inTerm) return; // xterm's custom key handler deals with it
      const dev = !!useUi.getState().appInfo?.dev;
      const cmd = appShortcut(e, false, dev);
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        runAppCommand(cmd);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const rightOpen = layout.rightOpen && !narrow;
  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {showConnect ? (
          <ConnectScreen />
        ) : (
          <>
            {layout.sidebarOpen && (
              <>
                <div style={{ width: layout.sidebarWidth }} className="shrink-0">
                  <Sidebar />
                </div>
                <Splitter
                  side="left"
                  onDrag={(dx) =>
                    useUi.getState().setLayout({
                      sidebarWidth: Math.max(220, Math.min(420, useUi.getState().layout.sidebarWidth + dx)),
                    })
                  }
                />
              </>
            )}
            <main className="relative min-w-0 flex-1">
              <TerminalStack />
              {tabsCount === 0 && (
                <div className="absolute inset-0">
                  <StartScreen />
                </div>
              )}
            </main>
            {rightOpen && (
              <>
                <Splitter
                  side="right"
                  onDrag={(dx) =>
                    useUi.getState().setLayout({
                      rightWidth: Math.max(280, Math.min(560, useUi.getState().layout.rightWidth + dx)),
                    })
                  }
                />
                <div style={{ width: layout.rightWidth }} className="shrink-0">
                  <RightPanel />
                </div>
              </>
            )}
          </>
        )}
      </div>
      <StatusBar />
      <Palette />
      <ChatSearch />
      <SystemView />
      <SettingsOverlay />
      <Dialogs />
      <AskpassDialog />
      <Toasts />
      <UpdateNotice />
    </div>
  );
}
