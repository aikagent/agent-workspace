import { describe, expect, test } from "bun:test";
import { draft, proposeRouting, type Runner } from "../src/omp";

const CORE = "/tool/core";
const calls: { cmd: string; args: string[]; cwd: string }[] = [];
const runner =
  (stdout: string, status = 0): Runner =>
  (cmd, args, opts) => (calls.push({ cmd, args, cwd: opts.cwd }), { status, stdout });

describe("draft", () => {
  test("runs omp headless and read-only in the repo folder (anything but reads needs an approval nobody can give)", () => {
    calls.length = 0;
    draft(runner("text"), CORE, "/ws/projects/acme/app/app", "write it");
    expect(calls[0]).toEqual({
      cmd: "omp",
      args: ["-p", "--no-session", "--approval-mode", "always-ask", "--tools", "read,grep,glob", "--config", "/tool/core/adapters/agent/omp/draft.yml", "write it"],
      cwd: "/ws/projects/acme/app/app",
    });
  });

  test("strips a surrounding code fence and fails soft", () => {
    expect(draft(runner("```markdown\n# App\nBuild: make\n```\n"), CORE, "/r", "p")).toBe("# App\nBuild: make");
    expect(draft(runner("", 1), CORE, "/r", "p")).toBeUndefined();
  });
});

describe("proposeRouting", () => {
  const report = (provider: string) => ({ provider, limits: [{ id: `${provider}:5h`, amount: { usedFraction: 0.1 }, window: { durationMs: 18_000_000 } }] });

  test("keeps the role's current model first, then one model per other signed-in provider", () => {
    const current = { task: "a/mid" };
    const catalog = { a: ["a/mid", "a/big"], b: ["b/mid"], c: ["c/mid"] };
    expect(proposeRouting([report("a"), report("b")], current, ["task"], catalog)).toEqual({ task: ["a/mid", "b/mid"] });
  });
});
