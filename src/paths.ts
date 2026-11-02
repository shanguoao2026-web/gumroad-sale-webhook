import { isAbsolute, relative, resolve, sep } from 'node:path';

export function resolveInside(root: string, relPath: string): string {
  if (relPath.includes('\0')) {
    throw new Error('path escapes data dir');
  }
  const base = resolve(root);
  const full = resolve(base, relPath);
  const fromRoot = relative(base, full);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('path escapes data dir');
  }
  return full;
}
