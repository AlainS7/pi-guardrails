import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createEventBus } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createEventContext } from "../../tests/utils/pi-context";
import type { ResolvedConfig } from "../config";
import { setupPoliciesHook } from "./policies";

type ToolCallHandler = (
  event: {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  },
  ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

function createMockPi() {
  const handlers: ToolCallHandler[] = [];
  const eventBus = createEventBus();

  const pi = {
    on(event: string, handler: ToolCallHandler) {
      if (event === "tool_call") handlers.push(handler);
    },
    events: eventBus,
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    emit: vi.fn(),
  } as unknown as ExtensionAPI;

  return {
    pi,
    getHandler(): ToolCallHandler {
      if (handlers.length === 0) throw new Error("No tool_call handler");
      return handlers[0];
    },
  };
}

const PI_HOME_CWD = join(homedir(), ".pi");
const CURSOR_PROVIDER_DIR = join(
  homedir(),
  ".pi/agent/extensions/cursor-provider",
);
const LS_RG_EXTENSIONS = `ls -la "${CURSOR_PROVIDER_DIR}" && rg --files "${CURSOR_PROVIDER_DIR}"`;
const LS_EXTENSIONS = `ls -la "${CURSOR_PROVIDER_DIR}"`;

function makeConfig(protection: "readOnly" | "noAccess"): ResolvedConfig {
  return {
    version: "1",
    enabled: true,
    applyBuiltinDefaults: true,
    features: { policies: true, permissionGate: false, pathAccess: false },
    pathAccess: { mode: "ask", allowedPaths: [] },
    permissionGate: {
      patterns: [],
      useBuiltinMatchers: true,
      requireConfirmation: true,
      allowedPatterns: [],
      autoDenyPatterns: [],
      explainCommands: false,
      explainModel: null,
      explainTimeout: 5000,
    },
    policies: {
      rules: [
        {
          id: "protect-extensions",
          patterns: [{ pattern: "~/.pi/agent/extensions/**" }],
          protection,
          onlyIfExists: false,
          enabled: true,
        },
      ],
    },
  };
}

describe("policies hook readOnly bash behavior", () => {
  it("allows clearly read-only bash command on readOnly targets", async () => {
    const { pi, getHandler } = createMockPi();
    setupPoliciesHook(pi, makeConfig("readOnly"));
    const handler = getHandler();

    const ctx = createEventContext({
      cwd: PI_HOME_CWD,
      hasUI: true,
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_policy_bash_read_only",
        toolName: "bash",
        input: {
          command: LS_RG_EXTENSIONS,
        },
      },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("blocks mutating bash command on readOnly targets", async () => {
    const { pi, getHandler } = createMockPi();
    setupPoliciesHook(pi, makeConfig("readOnly"));
    const handler = getHandler();

    const ctx = createEventContext({
      cwd: PI_HOME_CWD,
      hasUI: true,
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_policy_bash_write",
        toolName: "bash",
        input: {
          command: "echo hi > ~/.pi/agent/extensions/cursor-provider/tmp.txt",
        },
      },
      ctx,
    );

    expect(result).toEqual(expect.objectContaining({ block: true }));
  });

  it("still blocks read-only bash command when protection is noAccess", async () => {
    const { pi, getHandler } = createMockPi();
    setupPoliciesHook(pi, makeConfig("noAccess"));
    const handler = getHandler();

    const ctx = createEventContext({
      cwd: PI_HOME_CWD,
      hasUI: true,
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_policy_noaccess_bash",
        toolName: "bash",
        input: {
          command: LS_EXTENSIONS,
        },
      },
      ctx,
    );

    expect(result).toEqual(expect.objectContaining({ block: true }));
  });
});
