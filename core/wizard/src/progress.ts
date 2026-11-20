import { loadWorkspace, saveWorkspace } from "./workspace";

export const STEPS = ["tools", "signin", "org", "import", "projects", "roles", "context", "mcp", "routing", "delegation", "vault", "verify", "finish"] as const;
export type Step = (typeof STEPS)[number];

/** Wizard progress in workspace.yml `setup`: step ids done (plus context:<org>/<project> items), and whether Finish was reached. */
export function loadProgress(root: string): { done: string[]; finished: boolean } {
  const s = loadWorkspace(root).setup;
  return { done: s?.done ?? [], finished: s?.finished ?? false };
}

export function markDone(root: string, item: string): void {
  const ws = loadWorkspace(root);
  const p = loadProgress(root);
  saveWorkspace(root, { ...ws, setup: { done: p.done.includes(item) ? p.done : [...p.done, item], finished: p.finished || item === "finish" } });
}

/** First step after the always-run checks (tools, signin) that is not done yet; none once Finish was reached. */
export function nextStep(root: string): Step | undefined {
  const { done, finished } = loadProgress(root);
  // A workspace finished before a newer step existed stays finished; the new step is one "Change one step" away.
  return finished ? undefined : STEPS.slice(2).find((s) => !done.includes(s));
}

/** Clears the progress so every screen runs again; everything set up stays. */
export function restart(root: string): void {
  saveWorkspace(root, { ...loadWorkspace(root), setup: { done: [], finished: false } });
}
