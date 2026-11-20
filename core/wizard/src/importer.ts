/**
 * Import an existing folder of projects into the workspace. The source is only ever read: entries are copied
 * (copy-on-write clones where the file system supports them), and every later step works on the copies.
 * Anything in a copy that would still reach the source (git worktree links, symlinks, local config paths,
 * Python environments) is re-pointed to the copies, or disconnected and reported when it cannot be.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Runner } from "./omp";
import { projectAdd } from "./workspace";

export interface Entry {
  name: string;
  path: string;
  kind: "project" | "data";
  /** Org project this folder belongs to (repo folder name or git remote matches) and which of its repos. */
  projectId?: string;
  repo?: string;
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
const slug = (f: string) => f.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "project";
/** The folder name a source entry gets in the workspace: as is when safe, else its slug. */
export const repoName = (f: string) => (NAME.test(f) ? f : slug(f));

function remote(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The path a `.git` file or `gitdir` file points at. */
const gitdirTarget = (file: string) => readFileSync(file, "utf8").trim().replace(/^gitdir: /, "");

/** Top-level entries of the source with a proposal: project (matched to an org project when possible) or data. */
export function scanSource(src: string, org: OrgProject[]): Entry[] {
  return readdirSync(src)
    .filter((name) => name !== ".DS_Store")
    .sort()
    .map((name): Entry => {
      const path = join(src, name);
      if (!isDir(path)) return { name, path, kind: "data" };
      const dotGit = join(path, ".git");
      const url = existsSync(dotGit) ? remote(path) : undefined;
      let match: { id: string; repo: string } | undefined;
      for (const p of org) {
        const r = p.repos.find((x) => x.name === name || x.name === repoName(name)) ?? (url ? p.repos.find((x) => x.url && normUrl(x.url) === normUrl(url)) : undefined);
        if (r) {
          match = { id: p.id, repo: r.name };
          break;
        }
      }
      let worktreeOf: string | undefined;
      if (existsSync(dotGit) && !isDir(dotGit)) {
        const target = gitdirTarget(dotGit);
        const top = target.startsWith(`${src}/`) ? target.slice(src.length + 1).split("/")[0] : undefined;
        if (top && top !== name) worktreeOf = top;
      }
      const project = match || existsSync(dotGit) || AGENT_FILES.some((f) => existsSync(join(path, f)));
      return {
        name,
        path,
        kind: project ? "project" : "data",
        ...(match ? { projectId: match.id, repo: match.repo } : {}),
        ...(worktreeOf ? { worktreeOf } : {}),
      };
    });
}

/**
 * Copies a file or folder once (clone where supported; a top-level symlink is followed so its target is copied).
 * The copy is made under `<dest>.partial` and renamed on success, so a failed copy never looks finished.
 */
export function copyEntry(from: string, dest: string): "copied" | "present" {
  if (existsSync(dest)) return "present";
  mkdirSync(dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  const attempts: string[][] = process.platform === "darwin" ? [["-cRpH"], ["-RpH"]] : [["-R", "--reflink=auto", "-pH"], ["-RpH"]];
  for (const flags of attempts) {
    rmSync(partial, { recursive: true, force: true });
    try {
      execFileSync("cp", [...flags, from, partial], { stdio: "ignore" });
      renameSync(partial, dest);
      return "copied";
    } catch {
      // try the next form (no clone support on this file system)
    }
  }
  rmSync(partial, { recursive: true, force: true });
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

const underAny = (path: string, roots: string[]) => roots.some((r) => path === r || path.startsWith(`${r}/`));

/**
 * Re-points git worktree links inside the copies so no copy shares a repository with the source. A worktree whose
 * repository was not copied (left out, or outside the source) is disconnected: its `.git` file becomes `.git.copied`.
 */
export function repointWorktrees(copies: string[], src: string, map: Record<string, string>): { fixed: number; outside: string[]; disconnected: string[] } {
  let fixed = 0;
  const outside: string[] = [];
  const disconnected: string[] = [];
  const copyRoots = Object.values(map);
  for (const file of findFiles(copies, ["-name", "node_modules", "-prune", "-o", "-name", ".git", "-type", "f", "-print"])) {
    const target = gitdirTarget(file);
    if (!isAbsolute(target) || underAny(target, copyRoots)) continue; // submodules (relative) and links already fixed
    const mapped = mapPath(target, src, map);
    if (mapped !== undefined) {
      writeFileSync(file, `gitdir: ${mapped}\n`);
      fixed++;
    } else {
      renameSync(file, `${file}.copied`);
      disconnected.push(dirname(file));
    }
  }
  // Admin files in a copied repo naming its worktrees: harmless when unmapped (they live in the copy's own .git).
  for (const file of findFiles(copies, ["-path", "*/.git/worktrees/*/gitdir", "-type", "f"])) {
    const target = gitdirTarget(file);
    if (!target.startsWith(`${src}/`)) continue;
    const mapped = mapPath(target, src, map);
    if (mapped === undefined) outside.push(file);
    else {
      writeFileSync(file, `${mapped}\n`);
      fixed++;
    }
  }
  return { fixed, outside, disconnected };
}

/** Re-points absolute symlinks inside the copies that lead into the source; ones into entries not copied are reported. */
export function repointSymlinks(copies: string[], src: string, map: Record<string, string>): { fixed: number; outside: string[] } {
  let fixed = 0;
  const outside: string[] = [];
  for (const link of findFiles(copies, ["-name", "node_modules", "-prune", "-o", "-type", "l", "-print"])) {
    const target = readlinkSync(link);
    if (!target.startsWith(`${src}/`)) continue;
    const mapped = mapPath(target, src, map);
    if (mapped === undefined) {
      outside.push(link);
      continue;
    }
    unlinkSync(link);
    symlinkSync(mapped, link);
    fixed++;
  }
  return { fixed, outside };
}

const SKIP_DIRS = ["node_modules", ".git", ".venv", "venv", "*.copied", ".next", "dist", "out", "build", "__pycache__", ".pytest_cache", "graphify-out"];
const CONFIG_FILES = ["*.sh", "*.py", "*.ts", "*.js", "*.mjs", "*.json", "*.yml", "*.yaml", "*.toml", ".env*", "Makefile", "requirements*.txt"];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tracked(file: string): boolean {
  try {
    execFileSync("git", ["-C", dirname(file), "ls-files", "--error-unmatch", "--", basename(file)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The ways a path under `home` can be written: absolute, `~/…` and `$HOME/…`. */
function forms(path: string, home: string): string[] {
  const rel = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : undefined;
  return rel ? [path, `~/${rel}`, `$HOME/${rel}`] : [path];
}

/**
 * Rewrites source paths to the copies' paths in local config and script files of the copies that git does not track.
 * `srcs` lists every form the source folder is known by (as typed, and resolved). Tracked files would change the
 * repository: they are listed, not changed. Untracked files that still name the source afterwards are listed too.
 */
export function rewritePaths(copies: string[], srcs: string[], map: Record<string, string>, home: string): { rewritten: string[]; tracked: string[]; stillNaming: string[] } {
  const prune = SKIP_DIRS.flatMap((d, i) => [...(i ? ["-o"] : []), "-name", d]);
  const names = CONFIG_FILES.flatMap((n, i) => [...(i ? ["-o"] : []), "-name", n]);
  const files = findFiles(copies, ["(", ...prune, ")", "-prune", "-o", "-type", "f", "(", ...names, ")", "-print"]).sort();
  const roots = [...new Set(srcs)];
  // Longest top first, so "app-wt" is not read as "app".
  const rules: [RegExp, string][] = Object.entries(map)
    .sort((a, b) => b[0].length - a[0].length)
    .flatMap(([top, dest]) => {
      const to = forms(dest, home);
      return roots.flatMap((s) => forms(`${s}/${top}`, home).map((from, i): [RegExp, string] => [new RegExp(`${escape(from)}(?![\\w.-])`, "g"), to[i] ?? dest]));
    });
  const sourceMarks = roots.flatMap((s) => forms(s, home).map((f) => `${f}/`));
  const result = { rewritten: [] as string[], tracked: [] as string[], stillNaming: [] as string[] };
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const next = rules.reduce((t, [re, to]) => t.replace(re, to), text);
    if (next === text && !sourceMarks.some((m) => text.includes(m))) continue;
    if (tracked(file)) {
      if (next !== text) result.tracked.push(file);
      continue;
    }
    if (next !== text) {
      writeFileSync(file, next);
      result.rewritten.push(file);
    }
    if (sourceMarks.some((m) => next.includes(m))) result.stillNaming.push(file);
  }
  return result;
}

export type VenvResult = "rebuilt" | "failed" | "renamed" | "kept" | "names-source";

/**
 * A copied Python virtual environment still runs the source's Python and editable installs, so installing into it would
 * change the source. Each one is kept as `<name>.copied` and rebuilt in the copy with uv (uv.lock or requirements.txt),
 * unless the project's manifests still name the source: building those would write into the source, so they are left.
 */
export function rebuildVenvs(roots: string[], src: string, run: Runner): { venv: string; result: VenvResult }[] {
  const out: { venv: string; result: VenvResult }[] = [];
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
    const manifests = readdirSync(project).filter((f) => /^requirements.*\.txt$|^pyproject\.toml$|^uv\.lock$/.test(f));
    if (manifests.some((f) => readFileSync(join(project, f), "utf8").includes(`${src}/`))) {
      out.push({ venv, result: "names-source" });
      continue;
    }
    const py = readFileSync(join(`${venv}.copied`, "pyvenv.cfg"), "utf8").match(/^version(?:_info)?\s*=\s*(\d+\.\d+)/m)?.[1];
    const ok = (r: { status: number | null }) => r.status === 0;
    let result: VenvResult;
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
  const s = slug(folder);
  const base = /^[a-z]/.test(s) ? s : `p-${s}`;
  const projects = join(orgDir, "projects");
  let id = base;
  for (let n = 2; existsSync(join(projects, id)); n++) id = `${base}-${n}`;
  const repo = repoName(folder);
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
  /** The source folder, resolved (no symlinks). */
  src: string;
  /** Other forms the source is known by (e.g. the path as typed through a symlink), for rewriting local paths. */
  srcAliases?: string[];
  home: string;
  run: Runner;
}

export interface ImportReport {
  copied: string[];
  newProjects: string[];
  worktrees: { fixed: number; outside: string[]; disconnected: string[] };
  links: { fixed: number; outside: string[] };
  paths: { rewritten: string[]; tracked: string[]; stillNaming: string[] };
  venvs: { venv: string; result: VenvResult }[];
  failed: { ref: string; error: string }[];
}

/**
 * Copies the chosen entries: projects into projects/<org>/<project>/<repo> (a project the org does not have yet is
 * added to the local org checkout), worktrees next to their repo, data into data/. Then re-points worktree links,
 * symlinks and local paths in all imported copies, rebuilds their Python environments and registers the projects.
 * Every pass runs on all copies, so a retry after an interrupted run finishes the job; nothing is copied twice.
 */
export function runImport(ctx: ImportCtx, entries: Entry[], onDone: (name: string) => void): ImportReport {
  const orgDir = join(ctx.root, "orgs", ctx.org);
  const dest: Record<string, string> = {};
  const ids = new Set<string>();
  const known = readOrgProjects(orgDir);
  const findKnown = (e: Entry) => {
    const byRepo = e.projectId && e.repo ? known.find((p) => p.id === e.projectId) : undefined;
    if (byRepo && e.repo) return { p: byRepo, repo: e.repo };
    const p = known.find((x) => x.repos.some((r) => r.name === e.name || r.name === repoName(e.name)));
    return p ? { p, repo: p.repos.find((r) => r.name === e.name || r.name === repoName(e.name))?.name ?? repoName(e.name) } : undefined;
  };
  const projects = entries.filter((e) => e.kind === "project");
  const isWorktree = (e: Entry) => !!e.worktreeOf && projects.some((p) => p.name === e.worktreeOf);
  const fresh: Entry[] = [];
  for (const e of projects.filter((x) => !isWorktree(x))) {
    const k = findKnown(e);
    if (k) {
      ids.add(k.p.id);
      dest[e.name] = join(ctx.root, "projects", ctx.org, k.p.name, k.repo);
    } else fresh.push(e);
  }
  for (const e of entries.filter((x) => x.kind === "data")) dest[e.name] = join(ctx.root, "data", e.name);
  const clash = () => {
    const seen = new Map<string, string>();
    for (const [name, d] of Object.entries(dest)) {
      const other = seen.get(d);
      if (other) throw new Error(`${other} and ${name} would both go to ${d}; import one of them`);
      seen.set(d, name);
    }
  };
  clash();
  const newProjects: string[] = [];
  for (const e of fresh) {
    const { id, repo } = defineProject(orgDir, e.name);
    ids.add(id);
    newProjects.push(join(orgDir, "projects", id));
    dest[e.name] = join(ctx.root, "projects", ctx.org, id, repo);
  }
  for (const e of projects.filter(isWorktree)) dest[e.name] = join(dirname(dest[e.worktreeOf as string]), repoName(e.name));
  clash();

  const copied: string[] = [];
  for (const e of entries) {
    if (copyEntry(e.path, dest[e.name]) === "copied") copied.push(dest[e.name]);
    onDone(e.name);
  }
  const all = entries.map((e) => dest[e.name]);
  const worktrees = repointWorktrees(all, ctx.src, dest);
  const links = repointSymlinks(all, ctx.src, dest);
  const paths = rewritePaths(all, [ctx.src, ...(ctx.srcAliases ?? [])], dest, ctx.home);
  const venvs = rebuildVenvs(all, ctx.src, ctx.run);
  const failed: { ref: string; error: string }[] = [];
  for (const id of ids) {
    try {
      projectAdd(ctx.root, `${ctx.org}/${id}`);
    } catch (e) {
      failed.push({ ref: `${ctx.org}/${id}`, error: (e as Error).message });
    }
  }
  return { copied, newProjects, worktrees, links, paths, venvs, failed };
}
