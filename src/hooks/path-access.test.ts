import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createEventBus } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventContext } from "../../tests/utils/pi-context";
import { configLoader } from "../config";
import {
  __resetPathAccessSessionStateForTests,
  setupPathAccessHook,
} from "./path-access";

vi.mock("../config", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  const scopeConfigs: Record<string, unknown> = {};

  return {
    ...original,
    configLoader: {
      getConfig: vi.fn(() => ({
        features: { pathAccess: true },
        pathAccess: { mode: "ask", allowedPaths: [] },
      })),
      getRawConfig: vi.fn((scope: string) =>
        Object.hasOwn(scopeConfigs, scope) ? scopeConfigs[scope] : null,
      ),
      save: vi.fn(async (scope: string, config: unknown) => {
        scopeConfigs[scope] = config;
      }),
    },
  };
});

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
  const toolHandlers: ToolCallHandler[] = [];
  const eventBus = createEventBus();

  const pi = {
    on(event: string, handler: ToolCallHandler) {
      if (event === "tool_call") {
        toolHandlers.push(handler);
      }
    },
    events: eventBus,
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    emit: vi.fn(),
  } as unknown as ExtensionAPI;

  return {
    pi,
    getToolHandler(): ToolCallHandler {
      if (toolHandlers.length === 0) throw new Error("No tool_call handler");
      return toolHandlers[0];
    },
  };
}

function setMockConfig(config: {
  features: { pathAccess: boolean };
  pathAccess: { mode: "allow" | "ask" | "block"; allowedPaths: string[] };
}) {
  (
    configLoader.getConfig as unknown as {
      mockReturnValue: (v: unknown) => void;
    }
  ).mockReturnValue(config);
}

describe("path access grant persistence and extension edit boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPathAccessSessionStateForTests();
    setMockConfig({
      features: { pathAccess: true },
      pathAccess: { mode: "ask", allowedPaths: [] },
    });
  });

  it("persists allow-file-always grants to global scope", async () => {
    const { pi, getToolHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getToolHandler();

    const ctx = createEventContext({
      cwd: "/Users/alainsoto/.pi/agent",
      hasUI: true,
      ui: {
        custom: vi.fn(
          async () => "allow-file-always",
        ) as ExtensionContext["ui"]["custom"],
      },
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_file_always",
        toolName: "read",
        input: {
          path: "/opt/homebrew/lib/node_modules/@aliou/pi-guardrails/README.md",
        },
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(configLoader.save).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({
        pathAccess: expect.objectContaining({
          allowedPaths: expect.arrayContaining([
            "/opt/homebrew/lib/node_modules/@aliou/pi-guardrails/README.md",
          ]),
        }),
      }),
    );
    expect(configLoader.save).not.toHaveBeenCalledWith(
      "local",
      expect.anything(),
    );
  });

  it("persists allow-dir-always grants to global scope", async () => {
    const { pi, getToolHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getToolHandler();

    const ctx = createEventContext({
      cwd: "/Users/alainsoto/.pi/agent",
      hasUI: true,
      ui: {
        custom: vi.fn(
          async () => "allow-dir-always",
        ) as ExtensionContext["ui"]["custom"],
      },
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_dir_always",
        toolName: "ls",
        input: {
          path: "/opt/homebrew/lib/node_modules",
        },
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(configLoader.save).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({
        pathAccess: expect.objectContaining({
          allowedPaths: expect.arrayContaining([
            "/opt/homebrew/lib/node_modules/",
          ]),
        }),
      }),
    );
    expect(configLoader.save).not.toHaveBeenCalledWith(
      "local",
      expect.anything(),
    );
  });

  it("asks before editing global extensions regardless cwd", async () => {
    setMockConfig({
      features: { pathAccess: true },
      pathAccess: {
        mode: "ask",
        allowedPaths: ["~/.pi/agent/extensions/"],
      },
    });

    const { pi, getToolHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getToolHandler();

    const select = vi.fn(
      async () => "Deny",
    ) as ExtensionContext["ui"]["select"];

    const ctx = createEventContext({
      cwd: "/Users/alainsoto/.pi",
      hasUI: true,
      ui: { select },
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_edit_prompt",
        toolName: "edit",
        input: {
          path: "~/.pi/agent/extensions/guardrails.json",
        },
      },
      ctx,
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
      }),
    );
    expect(select).toHaveBeenCalledOnce();
  });

  it("blocks extension edits in no-UI mode", async () => {
    setMockConfig({
      features: { pathAccess: true },
      pathAccess: {
        mode: "ask",
        allowedPaths: ["~/.pi/agent/extensions/"],
      },
    });

    const { pi, getToolHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getToolHandler();

    const ctx = createEventContext({
      cwd: "/Users/alainsoto/.pi",
      hasUI: false,
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_edit_no_ui",
        toolName: "edit",
        input: {
          path: "~/.pi/agent/extensions/guardrails.json",
        },
      },
      ctx,
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
      }),
    );
  });

  it("asks before bash commands that mention global extensions", async () => {
    const { pi, getToolHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getToolHandler();

    const select = vi.fn(
      async () => "Deny",
    ) as ExtensionContext["ui"]["select"];

    const ctx = createEventContext({
      cwd: "/Users/alainsoto/project",
      hasUI: true,
      ui: { select },
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_bash_edit_prompt",
        toolName: "bash",
        input: {
          command: "echo hi > ~/.pi/agent/extensions/guardrails.json",
        },
      },
      ctx,
    );

    expect(result).toEqual(expect.objectContaining({ block: true }));
    expect(select).toHaveBeenCalledOnce();
  });

  it("blocks bash variable-indirection edits in no-UI mode", async () => {
    const { pi, getToolHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getToolHandler();

    const ctx = createEventContext({
      cwd: "/Users/alainsoto/project",
      hasUI: false,
    });

    const result = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_bash_var_no_ui",
        toolName: "bash",
        input: {
          command:
            'TARGET="$HOME/.pi/agent/extensions/guardrails.json"; echo hi > "$TARGET"',
        },
      },
      ctx,
    );

    expect(result).toEqual(expect.objectContaining({ block: true }));
  });

  it("remembers allow-for-session decision", async () => {
    setMockConfig({
      features: { pathAccess: true },
      pathAccess: {
        mode: "ask",
        allowedPaths: ["~/.pi/agent/extensions/"],
      },
    });

    const { pi, getToolHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getToolHandler();

    const select = vi.fn(
      async () => "Allow for session",
    ) as ExtensionContext["ui"]["select"];

    const ctx = createEventContext({
      cwd: "/Users/alainsoto/project",
      hasUI: true,
      ui: { select },
    });

    const first = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_edit_session_1",
        toolName: "edit",
        input: {
          path: "~/.pi/agent/extensions/guardrails.json",
        },
      },
      ctx,
    );

    const second = await handler(
      {
        type: "tool_call",
        toolCallId: "tc_edit_session_2",
        toolName: "edit",
        input: {
          path: "~/.pi/agent/extensions/guardrails.json",
        },
      },
      ctx,
    );

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(select).toHaveBeenCalledOnce();
  });
});
