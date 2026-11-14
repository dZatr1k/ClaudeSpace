// The splash wired to the app: covers the window from start until the first connection is up. Hands over to
// the connection screen when the user has to act (needs-user), or to the main window on "open offline".
import { useEffect, useState } from 'react';
import { invoke } from '../bridge';
import { useConn } from '../stores/conn';
import { useUi } from '../stores/ui';
import { Splash } from './Splash';

const STARTED_AT = Date.now();
/** "Готово" stays this long before the fade, then the fade itself (--splash-fade in splash.css) */
const DONE_MS = 350;
const FADE_MS = 300;

function useHostLabel(): string {
  const c = useUi((u) => u.settings?.connection);
  if (!c) return '';
  if (c.mode === 'local') return 'локально';
  if (c.manual) return `${c.manual.user}@${c.manual.hostname}`;
  return c.host;
}

export function StartupSplash() {
  const state = useConn((c) => c.state);
  const host = useHostLabel();
  // already online (window reload): no splash at all
  const [phase, setPhase] = useState<'up' | 'leaving' | 'gone'>(() =>
    useConn.getState().state.kind === 'online' ? 'gone' : 'up',
  );

  const online = state.kind === 'online';
  const needsUser = state.kind === 'needs-user';

  useEffect(() => {
    if (phase !== 'up') return;
    if (needsUser) return setPhase('gone');
    if (!online) return;
    const t = setTimeout(() => setPhase('leaving'), DONE_MS);
    return () => clearTimeout(t);
  }, [online, needsUser, phase]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const t = setTimeout(() => setPhase('gone'), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase === 'gone') void invoke('app.splash', { on: false });
  }, [phase]);

  if (phase === 'gone') return null;
  return (
    <Splash
      state={state}
      host={host}
      startedAt={STARTED_AT}
      leaving={phase === 'leaving'}
      onRetry={() => void invoke('conn.retryNow')}
      onSkip={() => setPhase('gone')}
    />
  );
}
