import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface AgentDef {
  org: string;
  project: string;
  role: string;
  cwd: string;
  writes: boolean;
  readOnlyPaths: string[];
  mustNot: string[];
  /** agent.yml `launch.omp`. */
  launch: string;
}

export interface Target extends AgentDef {
  /** `<org>/<project>/<role>`. */
  key: string;
  repoPath: string;
  git: boolean;
}

const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);

/** Reads `<root>/agents/<org>/<project>/<role>/agent.yml`; a malformed file is skipped and named in `errors`. */
export function loadAgents(root: string, errors: string[] = []): AgentDef[] {
  const out: AgentDef[] = [];
  for (const org of dirs(join(root, "agents")))
    for (const project of dirs(join(root, "agents", org)))
      for (const role of dirs(join(root, "agents", org, project))) {
        const file = join(root, "agents", org, project, role, "agent.yml");
        if (!existsSync(file)) continue;
        try {
          const y = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, any>;
          if (typeof y?.cwd !== "string" || typeof y?.launch?.omp !== "string") throw new Error("needs cwd and launch.omp");
          out.push({
            org,
            project,
            role,
            cwd: y.cwd,
            writes: y.writes === true,
            readOnlyPaths: Array.isArray(y.readOnlyPaths) ? y.readOnlyPaths.map(String) : [],
            mustNot: Array.isArray(y.mustNot) ? y.mustNot.map(String) : [],
            launch: y.launch.omp,
          });
        } catch (e) {
          errors.push(`${file}: ${(e as Error).message}`);
        }
      }
  return out;
}

export function resolveTarget(
  agents: AgentDef[],
  project: string,
  role: string | undefined,
  mode: "execute" | "ask",
  repo: string | undefined,
  mainCwd: string,
  loadErrors: string[] = [],
): Target {
  const malformed = loadErrors.length ? `; skipped malformed agent files: ${loadErrors.join("; ")}` : "";
  const keys = [...new Set(agents.map((a) => `${a.org}/${a.project}`))].sort();
  let key = project;
  if (!project.includes("/")) {
    const hits = keys.filter((k) => k.endsWith(`/${project}`));
    if (hits.length > 1) throw new Error(`project "${project}" is in several orgs: ${hits.map((k) => k.split("/")[0]).join(", ")}; use org/project`);
    key = hits[0] ?? project;
  }
  if (!keys.includes(key)) throw new Error(`unknown project "${project}"; known: ${keys.join(", ")}${malformed}`);
  const mine = agents.filter((a) => `${a.org}/${a.project}` === key);
  const wanted = role ?? (mode === "execute" ? "dev" : "support");
  const def = mine.find((a) => a.role === wanted);
  if (!def) throw new Error(`${key} has no role "${wanted}"; roles: ${mine.map((a) => a.role).sort().join(", ")}${malformed}`);

  const cwd = realpathSync(def.cwd);
  if (inside(cwd, realpathSync(mainCwd))) throw new Error(`Main already works in ${key}`);
  const target = resolve(cwd, repo ?? ".");
  if (!existsSync(target)) throw new Error(`${repo} does not exist in ${key}`);
  const repoPath = realpathSync(target);
  if (!inside(cwd, repoPath)) throw new Error(`${repo} escapes ${key}`);
  if (def.writes) {
    const rel = relative(cwd, repoPath);
    if (def.readOnlyPaths.some((p) => inside(resolve(cwd, p), repoPath))) {
      throw new Error(`${rel || "."} is read-only for ${key}/${def.role}`);
    }
  }
  // git only when the repository's top level lies inside the agent's cwd (not a parent repository around it).
  let git = false;
  try {
    const top = execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    git = inside(cwd, realpathSync(top));
  } catch {}
  return { ...def, cwd, key: `${key}/${def.role}`, repoPath, git };
}
