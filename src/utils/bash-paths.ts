import { resolve } from "node:path";
import { parse } from "@aliou/sh";
import { expandGlob, hasGlobChars } from "./glob-expander";
import { expandHomePath } from "./path";
import { walkCommands, wordToString } from "./shell-utils";

/**
 * Heuristic: is this token likely a filesystem path?
 * Intentionally conservative — only structural signals.
 * Known false positives: "application/json", URL paths. These cause
 * spurious prompts in ask mode but are safe (better to over-prompt than miss).
 * Known false negatives: bare filenames without path separators (e.g. "README.md").
 * These are usually cwd-relative and would pass the boundary check anyway.
 */
function maybePathLike(token: string): boolean {
  if (token.includes("/")) return true;
  if (token.includes("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (token.startsWith("~")) return true;
  return false;
}

function isCtx7Invocation(words: string[]): boolean {
  return words.some((word) => /(^|[/])ctx7(@|$)/.test(word));
}

function isCtx7LibraryId(token: string): boolean {
  if (!token.startsWith("/")) return false;
  const segments = token.split("/").filter(Boolean);
  if (segments.length < 2 || segments.length > 4) return false;
  return segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment));
}

async function expandCandidate(
  candidate: string,
  cwd: string,
): Promise<string[]> {
  if (!hasGlobChars(candidate)) return [candidate];
  const matches = await expandGlob(candidate, { cwd });
  return matches.length > 0 ? matches : [candidate];
}

/**
 * Extract path-like candidates from a bash command string.
 * Returns absolute paths. Best-effort: uses AST parsing with regex fallback.
 * Does NOT filter by any policy — returns all path-like arguments.
 */
export async function extractBashPathCandidates(
  command: string,
  cwd: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const results: string[] = [];

  const addCandidate = async (
    token: string,
    forcePath = false,
    skip = false,
  ): Promise<void> => {
    if (!token || token.startsWith("-")) return;
    if (skip) return;
    if (!forcePath && !maybePathLike(token)) return;

    const expanded = await expandCandidate(token, cwd);
    for (const file of expanded) {
      const abs = resolve(cwd, expandHomePath(file));
      if (!seen.has(abs)) {
        seen.add(abs);
        results.push(abs);
      }
    }
  };

  try {
    const { ast } = parse(command);
    const pending: Promise<void>[] = [];

    walkCommands(ast, (cmd) => {
      const words = (cmd.words ?? []).map(wordToString);
      const isCtx7 = isCtx7Invocation(words as string[]);

      for (let i = 1; i < words.length; i++) {
        const token = words[i] as string;
        const previous = String(words[i - 1] ?? "");
        const isCtx7LibraryArg =
          isCtx7 && previous === "docs" && isCtx7LibraryId(token);
        pending.push(addCandidate(token, false, isCtx7LibraryArg));
      }
      for (const redir of cmd.redirects ?? []) {
        pending.push(addCandidate(wordToString(redir.target), true));
      }
      return false;
    });

    await Promise.all(pending);
    return results;
  } catch {
    // Fallback: regex tokenization
    const tokenRegex = /"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s"'`<>|;&]+)/g;
    const tokens = [...command.matchAll(tokenRegex)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
    );
    const isCtx7 = isCtx7Invocation(tokens);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string;
      const previous = String(tokens[i - 1] ?? "");
      const isCtx7LibraryArg =
        isCtx7 && previous === "docs" && isCtx7LibraryId(token);
      if (token && !token.startsWith("-") && maybePathLike(token)) {
        await addCandidate(token, false, isCtx7LibraryArg);
      }
    }
    return results;
  }
}
