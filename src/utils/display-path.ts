export function toLegacyDisplayPath(value: string): string {
  if (process.platform !== 'darwin') return value;
  if (value.startsWith('/private/var/')) return value.slice('/private'.length);
  if (value.startsWith('/private/tmp/')) return value.slice('/private'.length);
  return value;
}
