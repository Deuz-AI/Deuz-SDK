/**
 * Path rules of the Docker runner (2.4). Host-side, a staged file or an
 * artifact is named by a normalized relative path (forward slashes, no empty,
 * `.` or `..` segment, no leading slash, no backslash or NUL), the digest
 * rule. Container-side paths are POSIX.
 */

/** Whether `path` is a normalized relative path. */
export function isNormalizedRelativePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path !== '' &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

/** Throws a TypeError unless `path` is a normalized relative path. */
export function assertRelativePath(path: unknown, what: string): asserts path is string {
  if (!isNormalizedRelativePath(path))
    throw new TypeError(
      `${what} must be a normalized relative path (forward slashes, no '.', '..' or empty segment), got ${JSON.stringify(path)}`,
    );
}

/** Normalizes an absolute or relative POSIX path against `base`, `..` popping a segment. */
export function posixResolve(base: string, path: string): string {
  const stack: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return `/${stack.join('/')}`;
}

/** Whether container path `target` is `root` or below it. */
export function isWithinPosix(root: string, target: string): boolean {
  return target === root || target.startsWith(root === '/' ? '/' : `${root}/`);
}

/** The parent of an absolute POSIX path (`/` for a top-level one). */
export function posixDirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

/** The last segment of an absolute POSIX path. */
export function posixBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Throws a TypeError unless `workdir` is an absolute, normalized POSIX path below `/`. */
export function assertWorkdir(workdir: unknown): asserts workdir is string {
  if (
    typeof workdir !== 'string' ||
    !workdir.startsWith('/') ||
    workdir === '/' ||
    posixResolve('/', workdir) !== workdir ||
    workdir.includes('\0')
  )
    throw new TypeError(
      `workdir must be an absolute, normalized POSIX path below '/', got ${JSON.stringify(workdir)}`,
    );
}
