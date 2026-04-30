import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isClearlyReadOnlyBashCommand } from "./bash-intent";

const CURSOR_PROVIDER_DIR = join(
  homedir(),
  ".pi/agent/extensions/cursor-provider",
);

describe("isClearlyReadOnlyBashCommand", () => {
  it("returns true for ls + rg chain", () => {
    const cmd = `ls -la "${CURSOR_PROVIDER_DIR}" && rg --files "${CURSOR_PROVIDER_DIR}"`;
    expect(isClearlyReadOnlyBashCommand(cmd)).toBe(true);
  });

  it("returns false for output redirection", () => {
    expect(
      isClearlyReadOnlyBashCommand("echo hi > ~/.pi/agent/extensions/foo.txt"),
    ).toBe(false);
  });

  it("returns false for path-qualified command binaries", () => {
    expect(isClearlyReadOnlyBashCommand("/tmp/ls -la /tmp")).toBe(false);
  });

  it("returns false for shell substitutions", () => {
    expect(isClearlyReadOnlyBashCommand("ls $(pwd)")).toBe(false);
  });

  it("returns false for pipelines", () => {
    expect(isClearlyReadOnlyBashCommand("ls -la /tmp | wc -l")).toBe(false);
  });

  it("returns false for find -exec", () => {
    expect(
      isClearlyReadOnlyBashCommand(
        "find /tmp -name '*.txt' -exec rm -f {} \\;",
      ),
    ).toBe(false);
  });

  it("returns false for sort --compress-program", () => {
    expect(
      isClearlyReadOnlyBashCommand("sort --compress-program=sh /tmp/a.txt"),
    ).toBe(false);
  });

  it("returns false for mutating file commands", () => {
    expect(isClearlyReadOnlyBashCommand("cp /tmp/a /tmp/b")).toBe(false);
  });

  it("returns false for unknown commands", () => {
    expect(isClearlyReadOnlyBashCommand("python -c 'print(1)' ")).toBe(false);
  });
});
