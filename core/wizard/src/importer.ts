/**
 * Import an existing folder of projects into the workspace. The source is only ever read: entries are copied
 * (copy-on-write clones where the file system supports them), and every later step works on the copies.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Runner } from "./omp";
import { projectAdd } from "./workspace";

export interface Entry {
  name: string;
  path: string;
  kind: "project" | "data";
  /** Org project this folder belongs to (repo folder name or git remote matches). */
  projectId?: string;
  /** For a git worktree living next to its repo: the entry name of that repo. */
  worktreeOf?: string;
}

export interface OrgProject {
  id: string;
  repos: { name: string; url?: string }[];
}

const AGENT_FILES = ["CLAUDE.md", "AGENTS.md", ".claude", ".mcp.json", ".omp"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const normUrl = (u: string) => u.trim().replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();

function remote(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The path a `.git` file or `gitdir` file points at. */
function gitdirTarget(file: string): string {
  return readFileSync(file, "utf8").trim().replace(/^gitdir: /, "");
}

/** Top-level entries of the source with a proposal: project (matched to an org project when possible) or data. */
export function scanSource(src: string, org: OrgProject[]): Entry[] {
  return readdirSync(src)
    .filter((name) => name !== ".DS_Store")
    .sort()
    .map((name) => {
      const path = join(src, name);
      if (!isDir(path)) return { name, path, kind: "data" as const };
      const byName = org.find((p) => p.repos.some((r) => r.name === name));
      const url = existsSync(join(path, ".git")) ? remote(path) : undefined;
      const byUrl = url ? org.find((p) => p.repos.some((r) => r.url && normUrl(r.url) === normUrl(url))) : undefined;
      let worktreeOf: string | undefined;
      const dotGit = join(path, ".git");
      if (existsSync(dotGit) && !isDir(dotGit)) {
        const target = gitdirTarget(dotGit);
        const top = target.startsWith(`${src}/`) ? target.slice(src.length + 1).split("/")[0] : undefined;
        if (top && top !== name) worktreeOf = top;
      }
      const project = byName || byUrl || existsSync(dotGit) || AGENT_FILES.some((f) => existsSync(join(path, f)));
      return {
        name,
        path,
        kind: project ? ("project" as const) : ("data" as const),
        ...((byName ?? byUrl) ? { projectId: (byName ?? byUrl)?.id } : {}),
        ...(worktreeOf ? { worktreeOf } : {}),
      };
    });
}

/** Copies a file or folder once (clone where supported); an existing destination is left as it is. */
export function copyEntry(from: string, dest: string): "copied" | "present" {
  if (existsSync(dest)) return "present";
  mkdirSync(dirname(dest), { recursive: true });
  const attempts: string[][] =
    process.platform === "darwin" ? [["-cRp"], ["-Rp"]] : [["-R", "--reflink=auto", "-p"], ["-Rp"]];
  for (const flags of attempts) {
    try {
      execFileSync("cp", [...flags, from, dest], { stdio: "ignore" });
      return "copied";
    } catch {
      // try the next form (no clone support on this file system)
    }
  }
  throw new Error(`could not copy ${from}`);
}

function findFiles(roots: string[], args: string[]): string[] {
  return roots.flatMap((r) =>
    existsSync(r)
      ? execFileSync("find", [r, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
          .split("\n")
          .filter(Boolean)
      : [],
  );
}

/** Maps a path under the source (`<src>/<top>/rest`) to the same path in the copy of `<top>`, if `<top>` was copied. */
function mapPath(path: string, src: string, map: Record<string, string>): string | undefined {
  if (!path.startsWith(`${src}/`)) return undefined;
  const rest = path.slice(src.length + 1);
  const top = rest.split("/")[0];
  const dest = map[top];
  return dest === undefined ? undefined : join(dest, rest.slice(top.length + 1));
}

/** Re-points git worktree links inside the copies so no copy shares a repository with the source. */
export function repointWorktrees(copies: string[], src: string, map: Record<string, string>): { fixed: number; outside: string[] } {
  let fixed = 0;
  const outside: string[] = [];
  const files = [
    ...findFiles(copies, ["-name", "node_modules", "-prune", "-o", "-name", ".git", "-type", "f", "-print"]),
    ...findFiles(copies, ["-path", "*/.git/worktrees/*/gitdir", "-type", "f"]),
  ];
  for (const file of files) {
    const raw = readFileSync(file, "utf8").trim();
    const prefix = raw.startsWith("gitdir: ") ? "gitdir: " : "";
    const target = raw.slice(prefix.length);
    if (!target.startsWith(`${src}/`)) continue;
    const mapped = mapPath(target, src, map);
    if (mapped === undefined) {
      outside.push(file);
      continue;
    }
    writeFileSync(file, `${prefix}${mapped}\n`);
    fixed++;
  }
  return { fixed, outside };
}

const SKIP_DIRS = ["node_modules", ".git", ".venv", "venv", "*.copied", ".next", "dist", "out", "build", "__pycache__", ".pytest_cache", "graphify-out"];
const CONFIG_FILES = ["*.sh", "*.py", "*.ts", "*.js", "*.mjs", "*.json", "*.yml", "*.yaml", "*.toml", ".env*", "Makefile"];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tracked(file: string): boolean {
  try {
    execFileSync("git", ["-C", dirname(file), "ls-files", "--error-unmatch", "--", basename(file)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrites source paths (absolute, `~/…` and `$HOME/…`) to the copies' paths in local config and script files of the
 * copies that git does not track. Tracked files would change the repository: they are listed, not changed.
 */
export function rewritePaths(copies: string[], src: string, map: Record<string, string>, home: string): { rewritten: string[]; tracked: string[] } {
  const prune = SKIP_DIRS.flatMap((d, i) => [...(i ? ["-o"] : []), "-name", d]);
  const names = CONFIG_FILES.flatMap((n, i) => [...(i ? ["-o"] : []), "-name", n]);
  const files = findFiles(copies, ["(", ...prune, ")", "-prune", "-o", "-type", "f", "(", ...names, ")", "-print"]).sort();
  const underHome = (p: string) => (p.startsWith(`${home}/`) ? p.slice(home.length + 1) : undefined);
  // Longest top first, so "app-wt" is not read as "app".
  const rules = Object.entries(map)
    .sort((a, b) => b[0].length - a[0].length)
    .flatMap(([top, dest]) => {
      const out: [RegExp, string][] = [[new RegExp(`${escape(`${src}/${top}`)}(?![\\w.-])`, "g"), dest]];
      const relSrc = underHome(`${src}/${top}`);
      const relDest = underHome(dest);
      if (relSrc) {
        for (const p of ["~/", "$HOME/"]) out.push([new RegExp(`${escape(p + relSrc)}(?![\\w.-])`, "g"), relDest ? p + relDest : dest]);
      }
      return out;
    });
  const result = { rewritten: [] as string[], tracked: [] as string[] };
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const next = rules.reduce((t, [re, to]) => t.replace(re, to), text);
    if (next === text) continue;
    if (tracked(file)) result.tracked.push(file);
    else {
      writeFileSync(file, next);
      result.rewritten.push(file);
    }
  }
  return result;
}

/**
 * A copied Python virtual environment still runs the source's Python and editable installs, so installing into it would
 * change the source. Each one is kept as `<name>.copied` and rebuilt in the copy with uv (uv.lock or requirements.txt).
 */
export function rebuildVenvs(roots: string[], src: string, run: Runner): { venv: string; result: "rebuilt" | "failed" | "renamed" | "kept" }[] {
  const out: { venv: string; result: "rebuilt" | "failed" | "renamed" | "kept" }[] = [];
  for (const cfg of findFiles(roots, ["(", "-name", "node_modules", "-o", "-name", "*.copied", ")", "-prune", "-o", "-name", "pyvenv.cfg", "-print"])) {
    const venv = dirname(cfg);
    const activate = join(venv, "bin", "activate");
    if (!existsSync(activate) || !readFileSync(activate, "utf8").includes(`${src}/`)) continue;
    if (existsSync(`${venv}.copied`)) {
      out.push({ venv, result: "kept" });
      continue;
    }
    renameSync(venv, `${venv}.copied`);
    const project = dirname(venv);
    const name = basename(venv);
    const py = readFileSync(join(`${venv}.copied`, "pyvenv.cfg"), "utf8").match(/^version(?:_info)?\s*=\s*(\d+\.\d+)/m)?.[1];
    const ok = (r: { status: number | null }) => r.status === 0;
    let result: "rebuilt" | "failed" | "renamed";
    if (existsSync(join(project, "uv.lock"))) {
      const sync = ["uv", "sync", "--frozen", "-q"];
      result = ok(name === ".venv" ? run(sync[0], sync.slice(1), { cwd: project }) : run("env", [`UV_PROJECT_ENVIRONMENT=${name}`, ...sync], { cwd: project })) ? "rebuilt" : "failed";
    } else if (existsSync(join(project, "requirements.txt"))) {
      result =
        ok(run("uv", ["venv", "-q", ...(py ? ["--python", py] : []), name], { cwd: project })) &&
        ok(run("uv", ["pip", "install", "-q", "--python", join(project, name), "-r", "requirements.txt"], { cwd: project }))
          ? "rebuilt"
          : "failed";
    } else result = "renamed";
    out.push({ venv, result });
  }
  return out;
}

/** Adds an org project for a folder the engineer provides (no url). Returns its id and repo folder name. */
export function defineProject(orgDir: string, folder: string): { id: string; repo: string } {
  const slug = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "project";
  const base = /^[a-z]/.test(slug) ? slug : `p-${slug}`;
  const projects = join(orgDir, "projects");
  let id = base;
  for (let n = 2; existsSync(join(projects, id)); n++) id = `${base}-${n}`;
  const repo = NAME.test(folder) ? folder : id;
  mkdirSync(join(projects, id), { recursive: true });
  writeFileSync(join(projects, id, "project.yml"), Bun.YAML.stringify({ id, name: id, repos: [{ name: repo, default: true }] }, null, 2));
  writeFileSync(join(projects, id, "context.md"), `# ${folder}\nImported from an existing workspace. Read its README, CLAUDE.md or AGENTS.md first.\n`);
  return { id, repo };
}

/** The org's projects as defined in its checkout (id, folder name under projects/<org>/, repos). */
export function readOrgProjects(orgDir: string): (OrgProject & { name: string })[] {
  const dir = join(orgDir, "projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(join(dir, id, "project.yml")))
    .map((id) => {
      const p = Bun.YAML.parse(readFileSync(join(dir, id, "project.yml"), "utf8")) as { name?: string; repos?: { name: string; url?: string; default?: boolean }[] };
      return { id, name: p?.name ?? id, repos: Array.isArray(p?.repos) ? p.repos : [] };
    });
}

export interface ImportCtx {
  root: string;
  org: string;
  src: string;
  home: string;
  run: Runner;
}

export interface ImportReport {
  copied: string[];
  newProjects: string[];
  worktrees: { fixed: number; outside: string[] };
  paths: { rewritten: string[]; tracked: string[] };
  venvs: { venv: string; result: string }[];
}

/**
 * Copies the chosen entries: projects into projects/<org>/<project>/<repo> (a project the org does not have yet is
 * added to the local org checkout), worktrees next to their repo, data into data/. Then re-points worktree links and
 * local paths in the copies, rebuilds their Python environments and registers the projects. Re-runs copy nothing twice.
 */
export function runImport(ctx: ImportCtx, entries: Entry[], onDone: (name: string) => void): ImportReport {
  const orgDir = join(ctx.root, "orgs", ctx.org);
  const dest: Record<string, string> = {};
  const ids = new Set<string>();
  const newProjects: string[] = [];
  const projectDest = (e: Entry): string => {
    const known = readOrgProjects(orgDir);
    const match = known.find((p) => p.repos.some((r) => r.name === e.name)) ?? known.find((p) => p.id === e.projectId);
    if (match) {
      ids.add(match.id);
      const repo = match.repos.find((r) => r.name === e.name) ?? match.repos.find((r) => r.default) ?? match.repos[0];
      return join(ctx.root, "projects", ctx.org, match.name, repo?.name ?? e.name);
    }
    const { id, repo } = defineProject(orgDir, e.name);
    ids.add(id);
    newProjects.push(join(orgDir, "projects", id));
    return join(ctx.root, "projects", ctx.org, id, repo);
  };
  const projects = entries.filter((e) => e.kind === "project");
  for (const e of projects.filter((x) => !x.worktreeOf || !projects.some((p) => p.name === x.worktreeOf))) dest[e.name] = projectDest(e);
  for (const e of projects.filter((x) => dest[x.name] === undefined)) dest[e.name] = join(dirname(dest[e.worktreeOf as string]), e.name);
  for (const e of entries.filter((x) => x.kind === "data")) dest[e.name] = join(ctx.root, "data", e.name);

  const copied: string[] = [];
  for (const e of entries) {
    if (copyEntry(e.path, dest[e.name]) === "copied") copied.push(dest[e.name]);
    onDone(e.name);
  }
  const worktrees = repointWorktrees(copied, ctx.src, dest);
  const paths = rewritePaths(copied, ctx.src, dest, ctx.home);
  const venvs = rebuildVenvs(copied, ctx.src, ctx.run);
  for (const id of ids) projectAdd(ctx.root, `${ctx.org}/${id}`);
  return { copied, newProjects, worktrees, paths, venvs };
}
