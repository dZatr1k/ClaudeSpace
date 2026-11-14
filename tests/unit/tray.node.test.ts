// Stage 6: tray menu status lines.
import { describe, expect, it, vi } from 'vitest';
import { initialPcLinkState } from '../../src/shared/pclink';

vi.mock('electron', () => ({ Menu: {}, nativeImage: {}, Tray: class {} }));
const { connLine, pcLine } = await import('../../src/main/tray');

describe('tray status lines', () => {
  it('connection', () => {
    expect(connLine({ kind: 'online', since: 1, rttMs: 5, agent: '0.1.0', host: 'claude@vm' })).toBe(
      'VM: на связи (claude@vm)',
    );
    expect(connLine({ kind: 'offline', since: 1, retryAt: 2, attempt: 1, error: 'x' })).toMatch(/нет связи/);
    expect(connLine({ kind: 'connecting', step: 'auth', attempt: 0 })).toMatch(/подключение/);
    expect(connLine({ kind: 'needs-user', reason: 'passphrase' })).toMatch(/требуется/);
    expect(connLine({ kind: 'idle' })).toBe('VM: отключено');
  });
  it('PC tunnel and disks', () => {
    const s = {
      ...initialPcLinkState,
      tunnel: 'ours' as const,
      sshd: 'down' as const,
      mounts: [
        {
          src: 'C:\\Data',
          dst: '~/winfs/V',
          label: 'V',
          mounted: true,
          owned: true,
          busy: null,
          error: null,
        },
      ],
    };
    expect(pcLine(s)).toBe('ПК: туннель ✓ · sshd на ПК не отвечает · диск V ✓');
    expect(pcLine({ ...initialPcLinkState, tunnel: 'foreign' })).toBe('ПК: внешний туннель');
  });
});
