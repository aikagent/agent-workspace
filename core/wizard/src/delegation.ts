import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./omp";
import { delegationEnabled, delegationExtension, loadWorkspace, roleAdd, saveWorkspace, shq, type Check } from "./workspace";

/** Arguments of the one-time `tern` call that installs the delegation plugin. */
export const ternLinkArgs = (core: string): string[] => ["plugin", "link", join(core, "adapters", "terminal", "tern", "delegation")];

/** The same call as a shell line to show the engineer; the path is quoted. */
export const ternLinkCommand = (core: string): string => `tern plugin link ${shq(ternLinkArgs(core)[2])}`;

/** Sets (or clears) workspace.yml `delegation` and regenerates every agent so launch commands follow it. */
function apply(root: string, core: string, on: boolean): void {
  const ws = loadWorkspace(root);
  if (on) ws.delegation = "on";
  else delete ws.delegation;
  saveWorkspace(root, ws);
  for (const p of ws.projects) for (const r of p.roles) roleAdd(root, core, `${p.org}/${p.id}`, r);
}

export const delegationOn = (root: string, core: string): void => apply(root, core, true);
export const delegationOff = (root: string, core: string): void => apply(root, core, false);

const runtimeDir = (home: string) => join(home, ".agent-workspace", "delegation");

/** Checks for `verify`: loader, Tern plugin loaded, every agent launched with the extension, runtime dir writable. */
export function delegationChecks(root: string, core: string, home: string, run: Runner): Check[] {
  const ws = loadWorkspace(root);
  if (!delegationEnabled(ws)) return [{ check: "delegation off", ok: true }];
  const checks: Check[] = [{ check: "delegation loader present", ok: existsSync(join(root, ".omp", "extensions", "delegation.ts")), detail: ".omp/extensions/delegation.ts is missing" }];

  let loaded = false;
  try {
    const r = run("tern", ["plugin", "list", "--json"], { cwd: root, timeoutMs: 15_000 });
    const parsed: unknown = r.status === 0 ? JSON.parse(r.stdout) : undefined;
    const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(Reflect.get(parsed, "plugins")) ? Reflect.get(parsed, "plugins") : [];
    const problems: unknown = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Reflect.get(parsed, "problems") : undefined;
    const flagged = Array.isArray(problems) && problems.some((x) => JSON.stringify(x).includes("omp-delegation"));
    loaded = !flagged && items.some((x: unknown) => x && typeof x === "object" && Reflect.get(x, "id") === "omp-delegation" && Reflect.get(x, "loaded") !== false && Reflect.get(x, "status") !== "error");
  } catch {}
  checks.push({ check: "tern plugin omp-delegation loaded", ok: loaded, detail: `run: ${ternLinkCommand(core)}` });

  const ext = `-e '${delegationExtension(core)}'`;
  for (const p of ws.projects) {
    for (const r of p.roles) {
      const file = join(root, "agents", p.org, p.id, r, "agent.yml");
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      checks.push({ check: `agent ${p.org}/${p.id}/${r} launches with delegation`, ok: text.includes(ext), detail: "run: ./setup delegation on" });
    }
  }

  const dir = runtimeDir(home);
  let writable = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
    writable = true;
  } catch {}
  checks.push({ check: "delegation runtime dir writable", ok: writable, detail: dir });
  return checks;
}
