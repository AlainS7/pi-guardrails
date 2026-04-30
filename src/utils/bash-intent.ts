import {
  type Command,
  parse,
  type SimpleCommand,
  type Statement,
  type Word,
} from "@aliou/sh";
import { wordToString } from "./shell-utils";

const READ_ONLY_BASH_COMMANDS = new Set([
  "ls",
  "rg",
  "grep",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "find",
  "fd",
  "tree",
  "du",
  "sort",
  "uniq",
  "cut",
  "pwd",
  "realpath",
  "readlink",
  "dirname",
  "basename",
]);

const FIND_MUTATING_FLAGS = ["-exec", "-execdir", "-ok", "-okdir", "-delete"];
const FD_MUTATING_FLAGS = ["-x", "--exec"];
const RG_MUTATING_FLAGS = ["--pre"];
const SORT_MUTATING_FLAGS = ["--compress-program"];

function hasDynamicWordParts(word: Word): boolean {
  const queue = [...word.parts];

  while (queue.length > 0) {
    const part = queue.shift();
    if (!part) continue;

    if (
      part.type === "CmdSubst" ||
      part.type === "ProcSubst" ||
      part.type === "ArithExp" ||
      part.type === "ParamExp"
    ) {
      return true;
    }

    if (part.type === "DblQuoted") {
      queue.push(...part.parts);
    }
  }

  return false;
}

function hasDisallowedFlags(commandName: string, args: string[]): boolean {
  const normalizedArgs = args.map((arg) => arg.toLowerCase());

  if (
    commandName === "find" &&
    normalizedArgs.some((arg) =>
      FIND_MUTATING_FLAGS.some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
    )
  ) {
    return true;
  }

  if (
    commandName === "fd" &&
    normalizedArgs.some((arg) =>
      FD_MUTATING_FLAGS.some((flag) => arg === flag || arg.startsWith(flag)),
    )
  ) {
    return true;
  }

  if (
    commandName === "rg" &&
    normalizedArgs.some((arg) =>
      RG_MUTATING_FLAGS.some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
    )
  ) {
    return true;
  }

  if (
    commandName === "sort" &&
    normalizedArgs.some((arg) =>
      SORT_MUTATING_FLAGS.some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
    )
  ) {
    return true;
  }

  return false;
}

function isSimpleCommandReadOnly(command: SimpleCommand): boolean {
  if ((command.redirects?.length ?? 0) > 0) return false;
  if ((command.assignments?.length ?? 0) > 0) return false;

  const words = command.words ?? [];
  if (words.length === 0) return false;
  if (words.some(hasDynamicWordParts)) return false;

  const tokens = words.map(wordToString);
  const commandToken = tokens[0]?.trim() ?? "";
  if (!commandToken) return false;

  // Force PATH-independent command identity for the allowlist check.
  if (commandToken.includes("/") || commandToken.includes("\\")) return false;

  const commandName = commandToken.toLowerCase();
  if (!READ_ONLY_BASH_COMMANDS.has(commandName)) return false;

  return !hasDisallowedFlags(commandName, tokens.slice(1));
}

function isStatementReadOnly(statement: Statement): boolean {
  if (statement.background || statement.negated) return false;
  return isCommandReadOnly(statement.command);
}

function isCommandReadOnly(command: Command): boolean {
  switch (command.type) {
    case "SimpleCommand":
      return isSimpleCommandReadOnly(command);

    case "Logical":
      return (
        isStatementReadOnly(command.left) && isStatementReadOnly(command.right)
      );

    // Pipelines and all control structures are disallowed for the read-only bypass.
    case "Pipeline":
    case "Subshell":
    case "Block":
    case "IfClause":
    case "ForClause":
    case "SelectClause":
    case "WhileClause":
    case "CaseClause":
    case "FunctionDecl":
    case "TimeClause":
    case "TestClause":
    case "ArithCmd":
    case "CoprocClause":
    case "DeclClause":
    case "LetClause":
    case "CStyleLoop":
      return false;
  }
}

/**
 * Returns true only when a bash command is structurally read-only.
 * Strict by design: parse errors and unsupported shell constructs return false.
 */
export function isClearlyReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  try {
    const { ast } = parse(trimmed);
    if (ast.body.length === 0) return false;
    return ast.body.every(isStatementReadOnly);
  } catch {
    return false;
  }
}
