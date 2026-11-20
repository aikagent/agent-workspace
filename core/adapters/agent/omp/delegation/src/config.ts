import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The workspace root: AGENT_WORKSPACE_ROOT, else two levels above core/ (this file is core/adapters/agent/omp/delegation/src). */
export function workspaceRoot(env = process.env, here = import.meta.dir): string {
  return env.AGENT_WORKSPACE_ROOT ? resolve(env.AGENT_WORKSPACE_ROOT) : resolve(dirname(here), "../../../../..");
}

/** AGENT_WORKSPACE_DELEGATION_DIR exists for tests only; real runs always use ~/.agent-workspace/delegation. */
export function runtimeDir(env = process.env): string {
  return env.AGENT_WORKSPACE_DELEGATION_DIR ?? join(homedir(), ".agent-workspace", "delegation");
}

/** The one place that reads the flag: the string "on" or boolean true (YAML 1.1 readers turn a bare `on` into true). */
export const flagOn = (v: unknown): boolean => v === "on" || v === true;

/** workspace.yml `delegation: on`. Absent, "off" or unreadable = off. */
export function delegationOn(root: string): boolean {
  const file = join(root, "workspace.yml");
  if (!existsSync(file)) return false;
  try {
    return flagOn((Bun.YAML.parse(readFileSync(file, "utf8")) as { delegation?: unknown } | null)?.delegation);
  } catch {
    return false;
  }
}

/** Main side is only active when omp starts in the workspace root itself. */
export function isWorkspaceRoot(root: string, cwd: string): boolean {
  try {
    return realpathSync(root) === realpathSync(cwd);
  } catch {
    return false;
  }
}
