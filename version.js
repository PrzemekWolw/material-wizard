export const VERSION = '0.3.0';

export function versionNewer(value) {
  const part = (text) => String(text || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const file = part(value);
  const here = part(VERSION);
  for (let i = 0; i < 3; i++) {
    if ((file[i] || 0) !== (here[i] || 0)) return (file[i] || 0) > (here[i] || 0);
  }
  return false;
}
