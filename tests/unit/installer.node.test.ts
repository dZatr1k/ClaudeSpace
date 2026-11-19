// The agent on the VM is shared by every app that connects (the PC, the phone): installPlan keeps a newer one in
// place instead of replacing it. agentCommand passes this connection's app id (agent/cclib/route.py).
import { describe, expect, it } from 'vitest';
import { agentCommand, compareVersions, installPlan } from '../../src/main/agent/installer';
import type { Manifest } from '../../src/main/agent/installer';

const m = (app: string | undefined, hash: string, protocol = 1): Manifest => ({
  agent: '0.4.0',
  app,
  protocol,
  files: {},
  hash,
});

describe('compareVersions', () => {
  it('compares release numbers, not strings', () => {
    expect(compareVersions('0.7.10', '0.7.9')).toBeGreaterThan(0);
    expect(compareVersions('0.8.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-dev', '1.2.3')).toBe(0);
  });
  it('null when either is not a release number', () => {
    expect(compareVersions(undefined, '0.7.10')).toBeNull();
    expect(compareVersions('0.7', '0.7.10')).toBeNull();
    expect(compareVersions('0.7.10', 'latest')).toBeNull();
  });
});

describe('installPlan', () => {
  const ours = m('0.8.0', 'h-ours');
  it('same files: nothing to do', () => {
    expect(installPlan(m('0.7.0', 'h-ours'), ours)).toBe('same');
  });
  it('nothing installed, an older or an equal release: install ours', () => {
    expect(installPlan(null, ours)).toBe('install');
    expect(installPlan(m('0.7.10', 'h-old'), ours)).toBe('install');
    expect(installPlan(m('0.8.0', 'h-dev'), ours)).toBe('install');
    expect(installPlan(m(undefined, 'h-before-0.7.11'), ours)).toBe('install');
  });
  it('a newer release on the same protocol stays', () => {
    expect(installPlan(m('0.8.1', 'h-new'), ours)).toBe('keep-newer');
  });
  it('a newer release on another protocol: this app is too old', () => {
    expect(installPlan(m('0.9.0', 'h-new', 2), ours)).toBe('app-too-old');
  });
});

describe('agentCommand', () => {
  it('passes the app id when it is 16 hex digits', () => {
    expect(agentCommand(null, '0123456789abcdef')).toMatch(/serve --protocol 1 --app 0123456789abcdef$/);
    expect(agentCommand(null, '$(id)')).not.toContain('--app');
    expect(agentCommand('test-sock')).toContain(`CSAGENT_TMUX_SOCKET='test-sock' exec python3`);
  });
});
