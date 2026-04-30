import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  Spacer,
  Text,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { configLoader } from "../config";
import { isClearlyReadOnlyBashCommand } from "../utils/bash-intent";
import { extractBashPathCandidates } from "../utils/bash-paths";
import { emitBlocked } from "../utils/events";
import {
  isWithinBoundaryResolved,
  normalizeForDisplay,
  resolveFromCwd,
  toStorageForm,
} from "../utils/path";
import {
  checkPathAccessResolved,
  type PathAccessState,
} from "../utils/path-access";

// Grant result type from the UI prompt
type PromptResult =
  | "allow-file-once"
  | "allow-dir-once"
  | "allow-file-session"
  | "allow-dir-session"
  | "allow-file-always"
  | "allow-dir-always"
  | "deny";

// Pending grant to be persisted after all targets pass
interface PendingGrant {
  storagePath: string; // in storage form (~/..., trailing / for dirs)
  scope: "memory" | "global";
  absolutePath: string; // for in-loop matching
}

const GLOBAL_EXTENSIONS_ROOT = resolve(homedir(), ".pi/agent/extensions");
const EDIT_TOOLS = new Set(["write", "edit"]);
const EXTENSION_PATH_MARKERS = [
  ".pi/agent/extensions",
  ".pi\\agent\\extensions",
];
const SELECT_ALLOW_ONCE = "Allow once";
const SELECT_ALLOW_SESSION = "Allow for session";
const SELECT_DENY = "Deny";
const EDIT_SELECTIONS = [
  SELECT_ALLOW_ONCE,
  SELECT_ALLOW_SESSION,
  SELECT_DENY,
] as const;

const sessionEditApproved = new Set<string>();

function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "unknown-session";
}

function commandMentionsGlobalExtensions(command: string): boolean {
  return EXTENSION_PATH_MARKERS.some((marker) => command.includes(marker));
}

async function requestExtensionsEditApproval(
  ctx: ExtensionContext,
): Promise<{ allow: true } | { allow: false; reason: string }> {
  const sessionId = getSessionId(ctx);
  if (sessionEditApproved.has(sessionId)) return { allow: true };

  if (!ctx.hasUI) {
    return {
      allow: false,
      reason:
        "Editing ~/.pi/agent/extensions is blocked until explicitly approved (no UI to confirm).",
    };
  }

  const selection = await ctx.ui.select(
    "Edit global Pi extensions (~/.pi/agent/extensions)?",
    [...EDIT_SELECTIONS],
  );

  if (selection === SELECT_ALLOW_ONCE) return { allow: true };
  if (selection === SELECT_ALLOW_SESSION) {
    sessionEditApproved.add(sessionId);
    return { allow: true };
  }

  return {
    allow: false,
    reason: "User denied editing ~/.pi/agent/extensions in this session.",
  };
}

async function enforceExtensionsEditBoundary(
  toolName: string,
  absolutePath: string,
  ctx: ExtensionContext,
): Promise<{ allow: true } | { allow: false; reason: string }> {
  if (!EDIT_TOOLS.has(toolName)) return { allow: true };
  if (!(await isWithinBoundaryResolved(absolutePath, GLOBAL_EXTENSIONS_ROOT))) {
    return { allow: true };
  }

  return requestExtensionsEditApproval(ctx);
}

async function enforceExtensionsBashBoundary(
  command: string,
  ctx: ExtensionContext,
): Promise<{ allow: true } | { allow: false; reason: string }> {
  if (!commandMentionsGlobalExtensions(command)) return { allow: true };
  if (isClearlyReadOnlyBashCommand(command)) return { allow: true };
  return requestExtensionsEditApproval(ctx);
}

/**
 * Resolve allowedPaths from config to absolute paths, preserving trailing-slash convention.
 */
function resolveAllowedPaths(allowedPaths: string[], cwd: string): string[] {
  return allowedPaths.map((p) => {
    const isDir = p.endsWith("/");
    const resolved = resolveFromCwd(isDir ? p.slice(0, -1) : p, cwd);
    return isDir ? `${resolved}/` : resolved;
  });
}

/**
 * Check if a grant path would be too broad (/ or home directory).
 */
function isGrantTooBroad(absPath: string): boolean {
  const home = homedir();
  const normalized = absPath.replace(/[\\/]+$/, "");
  return normalized === "/" || normalized === home;
}

/**
 * Collapse home directory to ~ for display.
 */
function displayCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

interface PromptOption {
  label: string;
  result: PromptResult;
}

const FILE_OPTIONS: PromptOption[] = [
  { label: "Allow once", result: "allow-file-once" },
  { label: "Allow file this session", result: "allow-file-session" },
  { label: "Allow file always", result: "allow-file-always" },
  { label: "Allow directory this session", result: "allow-dir-session" },
  { label: "Allow directory always", result: "allow-dir-always" },
  { label: "Deny", result: "deny" },
];

const DIR_OPTIONS: PromptOption[] = [
  { label: "Allow once", result: "allow-dir-once" },
  { label: "Allow directory this session", result: "allow-dir-session" },
  { label: "Allow directory always", result: "allow-dir-always" },
  { label: "Deny", result: "deny" },
];

/**
 * Build the confirmation UI component.
 * For directory-oriented tools (ls, find): only directory grant options.
 * For file tools and bash: both file and directory options.
 * Options rendered as highlighted tabs (selected = accent bg, unselected = dim),
 * navigable with ←/→/Tab/Shift+Tab.
 */
function createPromptComponent(
  toolName: string,
  displayPath: string,
  displayDir: string,
  cwd: string,
  showFileOptions: boolean,
) {
  return (
    tui: { terminal: { columns: number }; requestRender(): void },
    theme: {
      fg(color: string, text: string): string;
      bg(color: string, text: string): string;
      bold(text: string): string;
    },
    _kb: unknown,
    done: (result: PromptResult) => void,
  ) => {
    const options = showFileOptions ? FILE_OPTIONS : DIR_OPTIONS;
    let selectedIndex = 0;

    const container = new Container();
    const border = (s: string) => theme.fg("warning", s);
    const cwdDisplay = displayCwd(cwd);

    container.addChild(
      new Text(
        theme.fg("warning", theme.bold("Outside Workspace Access")),
        1,
        0,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg(
          "text",
          `\`${toolName}\` targets a path outside the working directory.`,
        ),
        1,
        0,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("dim", `  Cwd:  ${cwdDisplay}`), 1, 0),
    );
    container.addChild(
      new Text(theme.fg("dim", `  Path: ${displayPath}`), 1, 0),
    );
    container.addChild(
      new Text(theme.fg("dim", `  Dir:  ${displayDir}`), 1, 0),
    );
    container.addChild(new Spacer(1));

    // Dynamically rendered option lines
    const optionLines: Text[] = options.map(() => new Text("", 1, 0));
    for (const line of optionLines) {
      container.addChild(line);
    }

    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg("dim", "↑/↓/Tab select · Enter select · Esc deny"),
        1,
        0,
      ),
    );

    const renderOptions = () => {
      for (let i = 0; i < options.length; i++) {
        const label = options[i].label;
        if (i === selectedIndex) {
          optionLines[i].setText(
            theme.bg("selectedBg", theme.fg("accent", ` ${label} `)),
          );
        } else {
          optionLines[i].setText(theme.fg("dim", ` ${label} `));
        }
      }
    };

    renderOptions();

    const moveSelection = (direction: number) => {
      selectedIndex =
        (selectedIndex + direction + options.length) % options.length;
      renderOptions();
      tui.requestRender();
    };

    return {
      render: (width: number) => {
        const innerWidth = Math.max(1, width - 2);
        const contentWidth = Math.max(1, width - 4);
        const raw = container.render(contentWidth);
        const top = border(`╭${"─".repeat(innerWidth)}╮`);
        const bottom = border(`╰${"─".repeat(innerWidth)}╯`);
        const left = border("│");
        const right = border("│");
        const lines = raw.map((line) => {
          const visible = visibleWidth(line);
          const pad = Math.max(0, contentWidth - visible);
          return `${left} ${line}${" ".repeat(pad)} ${right}`;
        });
        return [top, ...lines, bottom];
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (
          matchesKey(data, Key.up) ||
          data === "k" ||
          matchesKey(data, Key.shift("tab"))
        ) {
          moveSelection(-1);
          return;
        }
        if (
          matchesKey(data, Key.down) ||
          data === "j" ||
          matchesKey(data, Key.tab)
        ) {
          moveSelection(1);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          done(options[selectedIndex].result);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done("deny");
        }
      },
    };
  };
}

/**
 * Persist a grant to the given config scope.
 * Re-reads raw config before saving to avoid clobbering concurrent changes.
 */
async function persistGrant(
  storagePath: string,
  scope: "memory" | "global",
): Promise<void> {
  const raw = (configLoader.getRawConfig(scope) ?? {}) as Record<
    string,
    unknown
  >;
  const pa = (raw.pathAccess ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(pa.allowedPaths)
    ? (pa.allowedPaths as string[])
    : [];

  if (existing.includes(storagePath)) return;

  await configLoader.save(scope, {
    ...raw,
    pathAccess: { ...pa, allowedPaths: [...existing, storagePath] },
  });
}

export function __resetPathAccessSessionStateForTests(): void {
  sessionEditApproved.clear();
}

export function setupPathAccessHook(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    // Read config live on every invocation
    const config = configLoader.getConfig();
    if (!config.features.pathAccess || config.pathAccess.mode === "allow")
      return;

    const toolName = event.toolName;
    let absolutePaths: string[] = [];

    const input = event.input as Record<string, unknown>;

    if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) {
      const raw = String(input.file_path ?? input.path ?? "").trim();
      if (raw) absolutePaths = [resolveFromCwd(raw, ctx.cwd)];
    } else if (toolName === "bash") {
      const command = String(input.command ?? "");
      const bashEditGate = await enforceExtensionsBashBoundary(command, ctx);
      if (!bashEditGate.allow) {
        emitBlocked(pi, {
          feature: "pathAccess",
          toolName,
          input: event.input,
          reason: bashEditGate.reason,
        });
        return { block: true, reason: bashEditGate.reason };
      }
      absolutePaths = await extractBashPathCandidates(command, ctx.cwd);
    } else {
      return;
    }

    if (absolutePaths.length === 0) return;

    // Deduplicate paths
    absolutePaths = [...new Set(absolutePaths)];

    const pendingGrants: PendingGrant[] = [];
    const isDirectoryTool = toolName === "ls" || toolName === "find";

    for (const absPath of absolutePaths) {
      // Build state with live config + pending grants from this loop
      const resolvedAllowed = resolveAllowedPaths(
        config.pathAccess.allowedPaths,
        ctx.cwd,
      );
      const pendingAllowedPaths = pendingGrants.map((g) => {
        const isDir = g.storagePath.endsWith("/");
        return isDir ? `${g.absolutePath}/` : g.absolutePath;
      });

      const state: PathAccessState = {
        cwd: ctx.cwd,
        mode: config.pathAccess.mode,
        allowedPaths: [...resolvedAllowed, ...pendingAllowedPaths],
        hasUI: ctx.hasUI,
      };

      const editGate = await enforceExtensionsEditBoundary(
        toolName,
        absPath,
        ctx,
      );
      if (!editGate.allow) {
        emitBlocked(pi, {
          feature: "pathAccess",
          toolName,
          input: event.input,
          reason: editGate.reason,
        });
        return { block: true, reason: editGate.reason };
      }

      const displayPath = normalizeForDisplay(absPath, ctx.cwd);
      const decision = await checkPathAccessResolved(
        absPath,
        displayPath,
        state,
      );

      if (decision.kind === "allow") continue;

      if (decision.kind === "deny") {
        emitBlocked(pi, {
          feature: "pathAccess",
          toolName,
          input: event.input,
          reason: decision.reason,
        });
        return { block: true, reason: decision.reason };
      }

      // decision.kind === "ask"
      const parentDir = dirname(absPath);
      const displayDir = normalizeForDisplay(parentDir, ctx.cwd);
      const showFileOptions = !isDirectoryTool;

      const result = await ctx.ui.custom<PromptResult>(
        createPromptComponent(
          toolName,
          displayPath,
          displayDir,
          ctx.cwd,
          showFileOptions,
        ),
      );

      // Handle "once" grants: just continue, do NOT add to pending
      if (result === "allow-file-once" || result === "allow-dir-once") {
        continue;
      }

      // Handle session/always grants
      if (result === "allow-file-session" || result === "allow-file-always") {
        const scope = result === "allow-file-session" ? "memory" : "global";
        const storage = toStorageForm(absPath, false);
        pendingGrants.push({
          storagePath: storage,
          scope,
          absolutePath: absPath,
        });
        continue;
      }

      if (result === "allow-dir-session" || result === "allow-dir-always") {
        const scope = result === "allow-dir-session" ? "memory" : "global";
        const dirPath = isDirectoryTool ? absPath : parentDir;

        if (isGrantTooBroad(dirPath)) {
          ctx.ui.notify(
            `Cannot grant access to ${normalizeForDisplay(dirPath, ctx.cwd)}/ — too broad. Treating as allow once.`,
            "warning",
          );
          continue;
        }

        const storage = toStorageForm(dirPath, true);
        pendingGrants.push({
          storagePath: storage,
          scope,
          absolutePath: dirPath,
        });
        continue;
      }

      // result === "deny"
      const reason = "User denied access outside working directory";
      emitBlocked(pi, {
        feature: "pathAccess",
        toolName,
        input: event.input,
        reason,
        userDenied: true,
      });
      return { block: true, reason };
    }

    // Persist grants only after ALL targets passed
    for (const grant of pendingGrants) {
      await persistGrant(grant.storagePath, grant.scope);
    }

    return;
  });
}
