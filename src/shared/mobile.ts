// The phone app's bridge (docs/MOBILE.md): what its web part may ask of the core and what the core reports. Most
// channels are the desktop IPC channels with the same types (ipc.ts); the core behind them is the Android service
// (mobile/core, step 5) or, in the browser, main's core run by Vite (src/main/mobileDev.ts).
import type { IpcContract, IpcEvents } from './ipc';
import type { ConnState } from './model';

export interface MobileSettings {
  connection: { host: string; port: number; user: string };
  appearance: {
    theme: 'system' | 'dark' | 'light';
    /** terminal font size, px */
    fontSize: number;
  };
}

export const MOBILE_FONT_MIN = 9;
export const MOBILE_FONT_MAX = 18;

export const defaultMobileSettings = (): MobileSettings => ({
  connection: { host: '', port: 22, user: '' },
  appearance: { theme: 'system', fontSize: 12 },
});

export interface MobileSettingsPatch {
  connection?: Partial<MobileSettings['connection']>;
  appearance?: Partial<MobileSettings['appearance']>;
}

/** Merge a patch into settings, dropping values out of range (the UI validates too; the core must not trust it). */
export function mergeMobileSettings(s: MobileSettings, p: MobileSettingsPatch): MobileSettings {
  const c = { ...s.connection, ...p.connection };
  const a = { ...s.appearance, ...p.appearance };
  return {
    connection: {
      host: String(c.host).trim().slice(0, 253),
      port: Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535 ? c.port : s.connection.port,
      user: String(c.user).trim().slice(0, 64),
    },
    appearance: {
      theme: ['system', 'dark', 'light'].includes(a.theme) ? a.theme : s.appearance.theme,
      fontSize:
        Number.isInteger(a.fontSize) && a.fontSize >= MOBILE_FONT_MIN && a.fontSize <= MOBILE_FONT_MAX
          ? a.fontSize
          : s.appearance.fontSize,
    },
  };
}

/** The phone's own SSH key: the line for ~/.ssh/authorized_keys and its fingerprint. */
export interface PhoneKey {
  publicKey: string;
  fingerprint: string;
}

type Same<K extends keyof IpcContract> = Pick<IpcContract, K>;

export type MobileContract = Same<
  | 'agent.call'
  | 'conn.state'
  | 'conn.retryNow'
  | 'conn.trustHost'
  | 'term.open'
  | 'term.write'
  | 'term.resize'
  | 'term.close'
  | 'term.ack'
  | 'attach.upload'
  | 'launch.openExternal'
> & {
  'settings.get': { args: undefined; result: MobileSettings };
  /** saving new connection settings reconnects */
  'settings.set': { args: MobileSettingsPatch; result: MobileSettings };
  'key.get': { args: undefined; result: PhoneKey };
  /** forget the trusted host key of the configured VM (after hostkey-mismatch, when the VM was reinstalled) */
  'conn.forgetHost': { args: undefined; result: void };
};

export type MobileChannel = keyof MobileContract;

export type MobileEvents = Pick<IpcEvents, 'agent.event' | 'term.data' | 'term.exit'> & {
  'conn.state': ConnState;
  'settings.changed': MobileSettings;
};
export type MobileEventName = keyof MobileEvents;

export interface MobileBridge {
  invoke<C extends MobileChannel>(
    channel: C,
    args?: MobileContract[C]['args'],
  ): Promise<MobileContract[C]['result']>;
  on<E extends MobileEventName>(event: E, cb: (data: MobileEvents[E]) => void): () => void;
  /** dev: the browser over Vite; android: the app's service */
  kind: 'dev' | 'android';
}
