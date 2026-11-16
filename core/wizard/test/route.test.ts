import { describe, expect, test } from "bun:test";
import { pickModels, type UsageReport } from "../../adapters/agent/omp/usage-router/route";

const NOW = 1_000_000;
const HOUR = 3_600_000;
const limits = { short: 95, week: 80 };

/** A provider report with a 5h and a 7d meter. */
function report(provider: string, shortUsed: number, weekUsed: number, shortResetIn = HOUR): UsageReport {
  return {
    provider,
    limits: [
      { id: `${provider}:5h`, amount: { usedFraction: shortUsed / 100 }, window: { durationMs: 5 * HOUR, resetsAt: NOW + shortResetIn } },
      { id: `${provider}:7d`, amount: { usedFraction: weekUsed / 100 }, window: { durationMs: 7 * 24 * HOUR, resetsAt: NOW + 100 * HOUR } },
    ],
  };
}

describe("pickModels", () => {
  test("skips a provider at the short-window or weekly limit", () => {
    const models = ["a/one", "b/two", "c/three"];
    const reports = [report("a", 95, 10), report("b", 10, 80), report("c", 94, 79)];
    expect(pickModels(models, reports, NOW, limits)).toEqual(["c/three"]);
  });

  test("a provider without a usage report is skipped: we cannot tell whether it is about to run out", () => {
    expect(pickModels(["a/one", "b/two"], [report("b", 0, 0)], NOW, limits)).toEqual(["b/two"]);
  });

  test("the provider whose short window resets soonest goes first; ties keep the configured order", () => {
    const reports = [report("a", 0, 0, 3 * HOUR), report("b", 0, 0, HOUR), report("c", 0, 0, 3 * HOUR)];
    expect(pickModels(["a/one", "b/two", "c/three"], reports, NOW, limits)).toEqual(["b/two", "a/one", "c/three"]);
  });

  test("a meter scoped to a model tier only gates models of that tier", () => {
    const anthropic = report("anthropic", 10, 10);
    anthropic.limits.push({ id: "anthropic:7d:fable", amount: { usedFraction: 0.9 }, window: { durationMs: 7 * 24 * HOUR }, scope: { tier: "fable" } });
    expect(pickModels(["anthropic/claude-fable-5", "anthropic/claude-sonnet-5"], [anthropic], NOW, limits)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  test("a shared meter gates every model even when it names a plan tier; a per-model meter gates only its model", () => {
    const plan = report("muse", 10, 10);
    plan.limits[0].scope = { tier: "pro", shared: true };
    plan.limits.push({ id: "muse:m2", amount: { usedFraction: 0.99 }, window: { durationMs: 5 * HOUR }, scope: { modelId: "m2" } });
    expect(pickModels(["muse/m1", "muse/m2"], [plan], NOW, limits)).toEqual(["muse/m1"]);
  });

  test("a provider with several accounts stays eligible while one account is under the limits", () => {
    const reports = [report("a", 99, 10), report("a", 10, 10, 2 * HOUR), report("b", 0, 0, 3 * HOUR)];
    expect(pickModels(["b/two", "a/one"], reports, NOW, limits)).toEqual(["a/one", "b/two"]);
  });

  test("a meter whose window has already reset no longer blocks", () => {
    expect(pickModels(["a/one"], [report("a", 99, 10, -HOUR)], NOW, limits)).toEqual(["a/one"]);
  });

  test("nothing eligible leaves routing to the agent", () => {
    expect(pickModels(["a/one"], [report("a", 99, 99)], NOW, limits)).toBeUndefined();
  });
});
