import { tmpdir } from 'node:os';

export function toLegacyDisplayPath(value: string): string {
  if (process.platform !== 'darwin') return value;
  const strippedPrivate = value.startsWith('/private/') ? value.slice('/private'.length) : value;
  if (value.startsWith('/private/var/')) return strippedPrivate;
  if (value.startsWith('/private/tmp/')) return strippedPrivate;
  const tempRoot = tmpdir();
  const envTmp = typeof process.env.TMPDIR === 'string' ? process.env.TMPDIR : '';
  const tempRoots = [tempRoot, envTmp];
  for (const root of [tempRoot, envTmp]) {
    if (root.startsWith('/private/')) {
      tempRoots.push(root.slice('/private'.length));
    }
  }
  for (const candidate of tempRoots) {
    if (candidate && candidate !== '/tmp' && strippedPrivate.startsWith(`${candidate}/`)) {
      return `/tmp/${strippedPrivate.slice(candidate.length + 1)}`;
    }
  }
  return strippedPrivate;
}
