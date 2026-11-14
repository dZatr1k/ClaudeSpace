// Port forwarding VM -> PC (BACKLOG 10): pure helpers shared by main and the renderer (unit-tested).

export interface ForwardInfo {
  vmPort: number;
  /** port on this PC (127.0.0.1); differs from vmPort when that one is taken here */
  localPort: number;
  pinned: boolean;
  /** open connections */
  conns: number;
  /** local mode: no forward needed, the VM port is reachable directly */
  direct: boolean;
}

export interface LocalUrl {
  scheme: 'http' | 'https';
  host: string;
  port: number;
  /** path + query + hash, at least '/' */
  rest: string;
}

const LOCAL_URL_RE =
  /^(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{1,5}))?([/?#][^\s]*)?$/i;

/** http(s)://localhost|127.0.0.1|0.0.0.0|[::1]:N/… -> parts; anything else -> null */
export function parseLocalUrl(url: string): LocalUrl | null {
  const m = LOCAL_URL_RE.exec(url.trim());
  if (!m) return null;
  const scheme = (m[1] as string).toLowerCase() as 'http' | 'https';
  const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let rest = m[4] ?? '/';
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return { scheme, host: (m[2] as string).toLowerCase(), port, rest };
}

/** the URL to open on the PC: same scheme/path, mapped port; 0.0.0.0 / [::] become localhost */
export function mapLocalUrl(u: LocalUrl, localPort: number): string {
  const host = u.host === '0.0.0.0' || u.host === '[::]' ? 'localhost' : u.host;
  return `${u.scheme}://${host}:${localPort}${u.rest}`;
}

export function portUrl(localPort: number): string {
  return `http://localhost:${localPort}/`;
}

/** local ports to try for a VM port: the same number first, then the next 20 */
export function candidatePorts(want: number): number[] {
  const out: number[] = [];
  for (let p = want; p <= Math.min(65535, want + 20); p++) out.push(p);
  return out;
}
