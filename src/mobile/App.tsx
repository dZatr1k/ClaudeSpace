// Which screen: the connection until it has been online once (or when it needs the user), then the lists, a chat or
// the settings. After the first connection a lost link is a banner over stale lists, not a full screen.
import { useConn } from '../renderer/stores/conn';
import { hasBridge } from './bridge';
import { Chat } from './screens/Chat';
import { ConnScreen, NoBridge } from './screens/Connect';
import { Home } from './screens/Home';
import { Settings } from './screens/Settings';
import { useApp } from './store';
import { ConfirmDialog, Toasts } from './ui';

export function App() {
  const conn = useConn((c) => c.state);
  const everOnline = useConn((c) => c.everOnline);
  const screen = useApp((s) => s.screen);
  const settings = useApp((s) => s.settings);

  if (!hasBridge()) return <NoBridge />;
  if (!settings) return null;

  let body;
  if (screen.kind === 'settings') body = <Settings />;
  else if (conn.kind === 'needs-user' || (!everOnline && conn.kind !== 'online'))
    body = <ConnScreen state={conn} />;
  else if (screen.kind === 'chat')
    body = <Chat key={screen.session} session={screen.session} chatId={screen.chatId} />;
  else body = <Home />;

  return (
    <>
      {body}
      <ConfirmDialog />
      <Toasts />
    </>
  );
}
