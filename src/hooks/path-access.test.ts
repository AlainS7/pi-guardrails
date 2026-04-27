import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createEventBus } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventContext } from "../../tests/utils/pi-context";
import { configLoader } from "../config";
import { setupPathAccessHook } from "./path-access";

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

describe("path access grant persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists allow-file-always grants to global scope", async () => {
    const { pi, getHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getHandler();

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
    const { pi, getHandler } = createMockPi();
    setupPathAccessHook(pi);
    const handler = getHandler();

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
});
