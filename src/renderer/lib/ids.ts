export function newId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return 't' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
