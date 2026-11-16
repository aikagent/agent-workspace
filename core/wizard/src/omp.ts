import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UsageReport } from "../../adapters/agent/omp/usage-router/route";

/** Runs a command; injectable so the wizard's omp calls can be tested offline. */
export type Runner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; inherit?: boolean; timeoutMs?: number },
) => { status: number | null; stdout: string };

export const spawnRunner: Runner = (cmd, args, { cwd, inherit, timeoutMs }) => {
  // Pass env explicitly: in Bun, changes to process.env do not reach child processes otherwise.
  const r = spawnSync(cmd, args, { cwd, env: process.env, stdio: inherit ? "inherit" : "pipe", encoding: "utf8", timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout ?? "" };
};

export const smoke = (run: Runner, cwd: string): boolean =>
  run("omp", ["-p", "--no-session", "Reply with exactly: OK"], { cwd, timeoutMs: 120_000 }).status === 0;

/** omp's own provider picker and login flow, with the terminal handed over. */
export const login = (run: Runner, cwd: string): void => void run("omp", ["login"], { cwd, inherit: true });

export function usage(run: Runner, cwd: string): UsageReport[] | undefined {
  const r = run("omp", ["usage", "--json"], { cwd, timeoutMs: 30_000 });
  if (r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout).reports ?? [];
  } catch {
    return undefined;
  }
}

type ShownLimit = { id: string; window?: { label?: string }; scope?: { tier?: string; shared?: boolean }; amount: { usedFraction?: number } };

/** Percent used per provider account and window, for display; meters scoped to one model tier say so. */
export function usageLines(reports: { provider: string; limits: ShownLimit[] }[]): Record<string, string[]> {
  const line = (l: ShownLimit) =>
    `${l.window?.label ?? l.id}${l.scope?.tier && !l.scope.shared ? ` (${l.scope.tier} only)` : ""}: ${Math.round((l.amount.usedFraction ?? 0) * 100)}%`;
  const count: Record<string, number> = {};
  return Object.fromEntries(
    reports.map((rep) => {
      count[rep.provider] = (count[rep.provider] ?? 0) + 1;
      const key = count[rep.provider] > 1 ? `${rep.provider} (account ${count[rep.provider]})` : rep.provider;
      return [key, rep.limits.filter((l) => typeof l.amount.usedFraction === "number").map(line)];
    }),
  );
}

/** True when the engineer's omp already routes models: global fallback chains, or a router extension. */
export function hasOwnRouting(run: Runner, cwd: string, agentDir: string): boolean {
  const chains = run("omp", ["config", "list"], { cwd }).stdout.match(/retry\.fallbackChains = (\{.*\})/)?.[1];
  const ext = join(agentDir, "extensions");
  return (chains !== undefined && chains !== "{}") || (existsSync(ext) && readdirSync(ext).some((d) => d.includes("router")));
}

/** The engineer's current model per role (e.g. default, task, slow, smol), from `omp config list`. */
export function modelRoles(run: Runner, cwd: string): Record<string, string> {
  const json = run("omp", ["config", "list"], { cwd }).stdout.match(/^\s*modelRoles = (\{.*\})/m)?.[1];
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

/** Chat models omp can use, as provider → selectors, from `omp models --json`. */
export function catalog(run: Runner, cwd: string): Record<string, string[]> {
  const r = run("omp", ["models", "--json"], { cwd, timeoutMs: 30_000 });
  if (r.status !== 0) return {};
  try {
    const out: Record<string, string[]> = {};
    for (const m of JSON.parse(r.stdout).models as { provider: string; kind: string; selector: string }[]) {
      if (m.kind === "chat") (out[m.provider] ??= []).push(m.selector);
    }
    return out;
  } catch {
    return {};
  }
}

export const CONTEXT_PROMPT = [
  "Write context.md for coding agents working in this repository: what it is, how to build, test and run it, the layout, and conventions to follow.",
  "At most 40 lines of Markdown. No secrets, hostnames or URLs from config files, personal data, or ticket contents.",
  "Output only the file content.",
].join(" ");

/**
 * Asks omp, headless and read-only, to write a text from the repo in cwd. Undefined when omp fails or says nothing.
 * always-ask: in a headless run only read-only tools are approved, so shell, writes and MCP calls are refused.
 */
export function draft(run: Runner, core: string, cwd: string, prompt: string): string | undefined {
  const overlay = join(core, "adapters", "agent", "omp", "draft.yml");
  const args = ["-p", "--no-session", "--approval-mode", "always-ask", "--tools", "read,grep,glob", "--config", overlay, prompt];
  const r = run("omp", args, { cwd, timeoutMs: 120_000 });
  if (r.status !== 0 || !r.stdout.trim()) return undefined;
  return r.stdout
    .trim()
    .replace(/^```[a-z]*\n([\s\S]*?)\n```$/, "$1")
    .trim();
}

/**
 * Proposes, per model role, the role's current model followed by one model from each other signed-in provider:
 * the catalog model whose id shares the longest prefix with the current one, so a mid-tier pick stays mid-tier.
 */
export function proposeRouting(
  reports: UsageReport[],
  current: Record<string, string>,
  roles: string[],
  catalog: Record<string, string[]>,
): Record<string, string[]> {
  const signedIn = [...new Set(reports.map((r) => r.provider))];
  const common = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  const out: Record<string, string[]> = {};
  for (const role of roles) {
    const first = current[role];
    if (!first) continue;
    const slash = first.indexOf("/");
    const id = first.slice(slash + 1);
    const picks = signedIn
      .filter((p) => p !== first.slice(0, slash))
      .flatMap((p) => {
        const models = catalog[p] ?? [];
        const score = (m: string) => common(m.slice(p.length + 1), id);
        return models.length ? [models.reduce((best, m) => (score(m) > score(best) ? m : best))] : [];
      });
    out[role] = [first, ...picks];
  }
  return out;
}
