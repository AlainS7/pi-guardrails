import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/**
 * Expand a leading tilde to the current user's home directory.
 * Preserves all other paths unchanged.
 */
export function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return join(homedir(), input.slice(2));
  return input;
}

export function resolveFromCwd(input: string, cwd: string): string {
  return resolve(cwd, expandHomePath(input));
}

/**
 * Lexical boundary check. Returns true if targetAbsPath equals rootAbsPath
 * or is a descendant. Both paths must already be resolved (absolute, no ..).
 * Does NOT resolve symlinks — this is a known limitation.
 */
export function isWithinBoundary(
  targetAbsPath: string,
  rootAbsPath: string,
): boolean {
  const rel = relative(rootAbsPath, targetAbsPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolvePathWithSymlinks(absPath: string): Promise<string> {
  const normalized = resolve(absPath);
  const unresolvedSegments: string[] = [];
  let cursor = normalized;

  while (true) {
    try {
      const resolvedBase = await realpath(cursor);
      return unresolvedSegments.reduce(
        (acc, segment) => resolve(acc, segment),
        resolvedBase,
      );
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        return normalized;
      }

      unresolvedSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Symlink-aware boundary check.
 * Resolves both paths through realpath (best-effort, supports non-existent leaf targets)
 * before applying lexical descendant checks.
 */
export async function isWithinBoundaryResolved(
  targetAbsPath: string,
  rootAbsPath: string,
): Promise<boolean> {
  const [resolvedTarget, resolvedRoot] = await Promise.all([
    resolvePathWithSymlinks(targetAbsPath),
    resolvePathWithSymlinks(rootAbsPath),
  ]);

  return isWithinBoundary(resolvedTarget, resolvedRoot);
}

/**
 * Format an absolute path for display:
 * - relative if inside cwd
 * - ~/... if under home
 * - absolute otherwise
 */
export function normalizeForDisplay(absPath: string, cwd: string): string {
  const home = homedir();
  const rel = relative(cwd, absPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    return rel || ".";
  if (
    absPath === home ||
    absPath.startsWith(`${home}/`) ||
    absPath.startsWith(`${home}\\`)
  ) {
    return `~${absPath.slice(home.length)}`;
  }
  return absPath;
}

/**
 * Convert an absolute path to storage form for config persistence.
 * Uses ~/ for home paths, absolute otherwise. Appends trailing / for directory grants.
 */
export function toStorageForm(absPath: string, isDirectory: boolean): string {
  const home = homedir();
  let stored: string;
  if (
    absPath === home ||
    absPath.startsWith(`${home}/`) ||
    absPath.startsWith(`${home}\\`)
  ) {
    stored = `~${absPath.slice(home.length)}`;
  } else {
    stored = absPath;
  }
  // Normalize separators to forward slash for storage
  stored = stored.replace(/\\/g, "/");
  if (isDirectory && !stored.endsWith("/")) stored += "/";
  if (!isDirectory && stored.endsWith("/")) stored = stored.slice(0, -1);
  return stored;
}
