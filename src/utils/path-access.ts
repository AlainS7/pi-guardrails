import { matchesGlob } from "node:path";
import { isWithinBoundary, isWithinBoundaryResolved } from "./path";

export type PathDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; absolutePath: string; displayPath: string };

export interface PathAccessState {
  cwd: string;
  mode: "allow" | "ask" | "block";
  allowedPaths: string[]; // already resolved to absolute, with trailing / convention
  hasUI: boolean;
}

/**
 * Check if an absolute path is covered by the allowedPaths list.
 * - Entries ending in "/" are directory grants (boundary/prefix match).
 * - Entries without trailing "/" are exact file grants.
 */
export function isPathAllowed(
  absPath: string,
  allowedPaths: string[],
): boolean {
  for (const entry of allowedPaths) {
    // Primary directory grant form.
    if (entry.endsWith("/")) {
      const dirPath = entry.slice(0, -1);
      if (isWithinBoundary(absPath, dirPath)) return true;
      continue;
    }

    // Back-compat: users often used "/path/*" or "/path/**" for directory grants.
    if (entry.endsWith("/*") || entry.endsWith("/**")) {
      const dirPath = entry.replace(/\/(?:\*|\*\*)$/, "");
      if (isWithinBoundary(absPath, dirPath)) return true;
      continue;
    }

    // Optional glob support for non-directory entries.
    if (/\*|\?|\[|\]|\{|\}/.test(entry)) {
      if (matchesGlob(absPath, entry)) return true;
      continue;
    }

    // Exact file grant.
    if (absPath === entry) return true;
  }
  return false;
}

export function checkPathAccess(
  absolutePath: string,
  displayPath: string,
  state: PathAccessState,
): PathDecision {
  if (state.mode === "allow") return { kind: "allow" };

  if (isWithinBoundary(absolutePath, state.cwd)) return { kind: "allow" };

  if (isPathAllowed(absolutePath, state.allowedPaths)) return { kind: "allow" };

  if (state.mode === "block") {
    return {
      kind: "deny",
      reason: `Access to ${displayPath} is blocked (outside working directory).`,
    };
  }

  // mode === "ask"
  if (!state.hasUI) {
    return {
      kind: "deny",
      reason: `Access to ${displayPath} is blocked (outside working directory, no UI to confirm).`,
    };
  }

  return { kind: "ask", absolutePath, displayPath };
}

/**
 * Symlink-aware variant used by tool hooks for boundary enforcement.
 */
export async function checkPathAccessResolved(
  absolutePath: string,
  displayPath: string,
  state: PathAccessState,
): Promise<PathDecision> {
  if (state.mode === "allow") return { kind: "allow" };

  if (await isWithinBoundaryResolved(absolutePath, state.cwd)) {
    return { kind: "allow" };
  }

  for (const entry of state.allowedPaths) {
    if (entry.endsWith("/")) {
      const dirPath = entry.slice(0, -1);
      if (await isWithinBoundaryResolved(absolutePath, dirPath)) {
        return { kind: "allow" };
      }
      continue;
    }

    if (entry.endsWith("/*") || entry.endsWith("/**")) {
      const dirPath = entry.replace(/\/(?:\*|\*\*)$/, "");
      if (await isWithinBoundaryResolved(absolutePath, dirPath)) {
        return { kind: "allow" };
      }
      continue;
    }

    if (/\*|\?|\[|\]|\{|\}/.test(entry)) {
      if (matchesGlob(absolutePath, entry)) return { kind: "allow" };
      continue;
    }

    if (absolutePath === entry) return { kind: "allow" };
  }

  if (state.mode === "block") {
    return {
      kind: "deny",
      reason: `Access to ${displayPath} is blocked (outside working directory).`,
    };
  }

  if (!state.hasUI) {
    return {
      kind: "deny",
      reason: `Access to ${displayPath} is blocked (outside working directory, no UI to confirm).`,
    };
  }

  return { kind: "ask", absolutePath, displayPath };
}
