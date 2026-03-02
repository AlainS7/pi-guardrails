import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import {
  configLoader,
  type GuardrailsConfig,
  type PolicyRule,
} from "../config";
import { executeSubagent, resolveModel } from "../lib";

const SYSTEM_PROMPT = `You are a policy configuration assistant for the pi-guardrails extension.

Your job is to help users create file protection rules. Each rule has:
- id: A kebab-case identifier (e.g. "drizzle-migrations", "lock-files")
- name: Optional display name for settings (e.g. "Drizzle migrations")
- description: What the rule protects and why
- patterns: File glob patterns to match (e.g. "*.lock", "**/drizzle/meta/**")
- allowedPatterns: Optional exceptions
- protection: One of:
  - "noAccess" - block ALL tool access (for secrets, credentials)
  - "readOnly" - block writes but allow reads (for generated/managed files)
  - "none" - explicitly unprotected (for overrides)
- onlyIfExists: Whether to only block if the file exists on disk (default true)
- blockMessage: Message explaining why access is blocked (supports {file} placeholder)

Ask the user what files they want to protect and what kind of protection they need.
Then use the createRule tool to save the rule.

Keep it simple. One rule at a time.`;

const createRuleParameters = Type.Object({
  scope: Type.Union([Type.Literal("global"), Type.Literal("local")], {
    description: "Where to save: global (~/.pi) or local (project .pi/)",
  }),
  rule: Type.Object({
    id: Type.String({ description: "Kebab-case identifier" }),
    name: Type.Optional(Type.String({ description: "Optional display name" })),
    description: Type.Optional(Type.String()),
    patterns: Type.Array(
      Type.Object({
        pattern: Type.String(),
        regex: Type.Optional(Type.Boolean()),
      }),
    ),
    allowedPatterns: Type.Optional(
      Type.Array(
        Type.Object({
          pattern: Type.String(),
          regex: Type.Optional(Type.Boolean()),
        }),
      ),
    ),
    protection: Type.Union([
      Type.Literal("noAccess"),
      Type.Literal("readOnly"),
      Type.Literal("none"),
    ]),
    onlyIfExists: Type.Optional(Type.Boolean()),
    blockMessage: Type.Optional(Type.String()),
  }),
});

type CreateRuleArgs = Static<typeof createRuleParameters>;

function normalizeRule(rule: PolicyRule): PolicyRule {
  return {
    ...rule,
    id: rule.id.trim(),
    name: rule.name?.trim() || undefined,
    patterns: rule.patterns
      .map((pattern) => ({ ...pattern, pattern: pattern.pattern.trim() }))
      .filter((pattern) => pattern.pattern.length > 0),
    allowedPatterns: rule.allowedPatterns
      ?.map((pattern) => ({ ...pattern, pattern: pattern.pattern.trim() }))
      .filter((pattern) => pattern.pattern.length > 0),
    description: rule.description?.trim() || undefined,
    blockMessage: rule.blockMessage?.trim() || undefined,
  };
}

function buildCreateRuleTool(): ToolDefinition {
  return {
    name: "createRule",
    label: "Create Rule",
    description: "Create and save a new policy rule",
    parameters: createRuleParameters,
    async execute(
      _toolCallId,
      toolArgs,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<AgentToolResult<unknown>> {
      const { scope, rule } = toolArgs as CreateRuleArgs;
      const normalized = normalizeRule(rule as PolicyRule);

      if (!normalized.id) {
        return {
          content: [{ type: "text", text: "Error: rule id is required." }],
          details: {},
        };
      }
      if (normalized.patterns.length === 0) {
        return {
          content: [
            { type: "text", text: "Error: at least one pattern is required." },
          ],
          details: {},
        };
      }

      const existing = (configLoader.getRawConfig(scope) ??
        {}) as GuardrailsConfig;
      const existingRules = existing.policies?.rules ?? [];

      const filtered = existingRules.filter(
        (existingRule) => existingRule.id !== normalized.id,
      );
      filtered.push(normalized);

      const updated: GuardrailsConfig = {
        ...existing,
        policies: {
          ...(existing.policies ?? {}),
          rules: filtered,
        },
      };

      await configLoader.save(scope, updated);

      return {
        content: [
          {
            type: "text",
            text: `Rule "${normalized.id}" saved to ${scope} config.`,
          },
        ],
        details: {},
      };
    },
  };
}

function resolveSubagentModel(ctx: ExtensionCommandContext) {
  try {
    return resolveModel("anthropic", "claude-haiku-4", ctx);
  } catch {
    const available = ctx.modelRegistry.getAvailable();
    if (available.length === 0) {
      throw new Error("No models available for /guardrails:add-policy");
    }
    return available[0];
  }
}

export function registerAddPolicyCommand(pi: ExtensionAPI): void {
  pi.registerCommand("guardrails:add-policy", {
    description: "Create a new policy rule with AI assistance",
    handler: async (args, ctx) => {
      let resolvedModel: ReturnType<typeof resolveSubagentModel> | null = null;
      try {
        resolvedModel = resolveSubagentModel(ctx);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
        return;
      }
      if (!resolvedModel) return;

      const userMessage = args.trim()
        ? args
        : "I want to create a new policy rule. What files should I protect?";

      try {
        const result = await executeSubagent(
          {
            name: "add-policy",
            model: resolvedModel,
            systemPrompt: SYSTEM_PROMPT,
            customTools: [buildCreateRuleTool()],
            thinkingLevel: "low",
          },
          userMessage,
          ctx,
        );

        if (result.error) {
          ctx.ui.notify(`Failed: ${result.error}`, "error");
          return;
        }

        if (result.content.trim()) {
          ctx.ui.notify(result.content.trim(), "info");
        }
      } catch (error) {
        ctx.ui.notify(`Failed: ${String(error)}`, "error");
      }
    },
  });
}
