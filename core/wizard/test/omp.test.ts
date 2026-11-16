import { describe, expect, test } from "bun:test";
import { catalog, draft, modelRoles, proposeRouting, usageLines, type Runner } from "../src/omp";

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

describe("reading omp's model setup", () => {
  test("current model roles come from omp config list", () => {
    const out = '  modelRoles = {"default":"a/big","task":"a/mid:high"} (record)\n  retry.enabled = true (boolean)\n';
    expect(modelRoles(runner(out), "/r")).toEqual({ default: "a/big", task: "a/mid:high" });
    expect(modelRoles(runner("  retry.enabled = true (boolean)\n"), "/r")).toEqual({});
  });

  test("the chat model catalog is grouped by provider", () => {
    const out = JSON.stringify({
      models: [
        { provider: "a", kind: "chat", selector: "a/mid" },
        { provider: "a", kind: "image", selector: "a/pic" },
        { provider: "b", kind: "chat", selector: "b/mid" },
      ],
    });
    expect(catalog(runner(out), "/r")).toEqual({ a: ["a/mid"], b: ["b/mid"] });
    expect(catalog(runner("", 1), "/r")).toEqual({});
  });
});

describe("usageLines", () => {
  test("one entry per provider account, tier-only meters labelled, percent rounded", () => {
    const meter = (label: string, used: number, scope?: { tier?: string; shared?: boolean }) => ({ id: label, amount: { usedFraction: used }, window: { label }, scope });
    const reports = [
      { provider: "a", limits: [meter("5h", 0.123), meter("7d", 0.04, { tier: "big" }), meter("plan", 0.5, { tier: "pro", shared: true })] },
      { provider: "a", limits: [meter("5h", 0.9)] },
    ];
    expect(usageLines(reports)).toEqual({ a: ["5h: 12%", "7d (big only): 4%", "plan: 50%"], "a (account 2)": ["5h: 90%"] });
  });
});
