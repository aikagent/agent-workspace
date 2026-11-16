import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadChain, mergeChain, type ResolvedRole } from "./roles";

export interface Workspace {
  tools?: { agent?: string; terminal?: string; secrets?: string };
  models?: Record<string, string>;
  orgs: { id: string; url: string }[];
  projects: { org: string; id: string; name: string; roles: string[] }[];
  notes?: { kind: "none" | "vault"; path?: string; folders?: Record<string, string> };
}

interface ProjectFile {
  id: string;
  name: string;
  repos: { name: string; url: string; default?: boolean }[];
  test?: Record<string, string>;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Tools that write files in omp; a read-only role denies all of them. */
const FILE_WRITERS = ["edit", "write", "ast_edit"];

const yaml = (file: string): unknown => Bun.YAML.parse(readFileSync(file, "utf8"));
const writeYaml = (file: string, value: unknown) => writeFileSync(file, Bun.YAML.stringify(value, null, 2));
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function checkId(kind: string, value: string): string {
  if (!ID.test(value)) throw new Error(`${kind} "${value}": must be lowercase letters, digits and dashes`);
  return value;
}

function checkName(kind: string, value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new Error(`${kind} name "${String(value)}" must be letters, digits, dots, dashes or underscores`);
  }
  return value;
}

function stringList(file: string, key: string): string[] {
  if (!existsSync(file)) return [];
  const parsed = yaml(file);
  const list: unknown = parsed && typeof parsed === "object" ? Reflect.get(parsed, key) : [];
  return Array.isArray(list) ? list.map(String) : [];
}

export function loadWorkspace(root: string): Workspace {
  const file = join(root, "workspace.yml");
  const ws = (existsSync(file) ? yaml(file) ?? {} : {}) as Partial<Workspace>;
  return { ...ws, orgs: ws.orgs ?? [], projects: ws.projects ?? [] };
}

export function saveWorkspace(root: string, ws: Workspace): void {
  writeYaml(join(root, "workspace.yml"), ws);
}

function clone(url: string, dest: string): void {
  execFileSync("git", ["clone", "--quiet", "--", url, dest], { stdio: ["ignore", "ignore", "inherit"] });
}

/** Clones an org repo into orgs/<id> (id read from its org.yml) and records it. Returns the id. */
export function orgAdd(root: string, url: string, core: string): string {
  const staging = join(root, "orgs", `.incoming-${process.pid}`);
  mkdirSync(join(root, "orgs"), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  clone(url, staging);
  try {
    const orgFile = join(staging, "org.yml");
    if (!existsSync(orgFile)) throw new Error(`${url} has no org.yml; start from ${join(core, "templates", "org")}`);
    const parsed = yaml(orgFile);
    const id = checkId("org", parsed && typeof parsed === "object" && "id" in parsed ? String(parsed.id) : "");
    const dest = join(root, "orgs", id);
    if (existsSync(dest)) throw new Error(`org "${id}" is already in ${dest}`);
    renameSync(staging, dest);
    const ws = loadWorkspace(root);
    ws.orgs = [...ws.orgs.filter((o) => o.id !== id), { id, url }];
    saveWorkspace(root, ws);
    return id;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseRef(ref: string): { org: string; project: string } {
  const [org, project, extra] = ref.split("/");
  if (!org || !project || extra !== undefined) throw new Error(`expected <org>/<project>, got "${ref}"`);
  return { org: checkId("org", org), project: checkId("project", project) };
}

function readProject(root: string, org: string, project: string): ProjectFile {
  const dir = join(root, "orgs", org, "projects");
  if (!existsSync(join(root, "orgs", org))) throw new Error(`org "${org}" is not added; run ./setup org add <git-url>`);
  const file = join(dir, project, "project.yml");
  if (!existsSync(file)) {
    const known = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "project.yml"))) : [];
    throw new Error(`project "${project}" not found in org ${org}; known: ${known.join(", ") || "none"}`);
  }
  const p = yaml(file) as ProjectFile;
  checkName("project", p?.name);
  if (!Array.isArray(p.repos) || p.repos.length === 0) throw new Error(`${file}: repos must list at least one repo`);
  for (const r of p.repos) {
    checkName("repo", r?.name);
    if (typeof r.url !== "string" || !r.url) throw new Error(`${file}: repo ${r.name} needs a url`);
  }
  return p;
}

const projectDir = (root: string, org: string, p: ProjectFile) => join(root, "projects", org, p.name);
const defaultRepoDir = (root: string, org: string, p: ProjectFile) =>
  join(projectDir(root, org, p), (p.repos.find((r) => r.default) ?? p.repos[0]).name);

/** Clones every repo of an org project into projects/<org>/<name>/<repo> and records it. Returns the default repo folder. */
export function projectAdd(root: string, ref: string): string {
  const { org, project } = parseRef(ref);
  const p = readProject(root, org, project);
  for (const r of p.repos) {
    const dest = join(projectDir(root, org, p), r.name);
    if (!existsSync(dest)) {
      mkdirSync(projectDir(root, org, p), { recursive: true });
      clone(r.url, dest);
    }
  }
  const ws = loadWorkspace(root);
  if (!ws.projects.some((x) => x.org === org && x.id === project)) {
    ws.projects.push({ org, id: project, name: p.name, roles: [] });
    saveWorkspace(root, ws);
  }
  return defaultRepoDir(root, org, p);
}

const globToRegex = (glob: string) => new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

function checkMcp(root: string, org: string, role: ResolvedRole): void {
  const mcpDir = join(root, "orgs", org, "mcp");
  const blocked = stringList(join(mcpDir, "block.yml"), "servers").map(globToRegex);
  const allowed = stringList(join(mcpDir, "allow.yml"), "servers");
  for (const server of role.mcp ?? []) {
    if (blocked.some((re) => re.test(server))) throw new Error(`role ${role.id}: ${server} is blocked by org ${org}`);
    if (!allowed.includes(server)) throw new Error(`role ${role.id}: ${server} is not in org ${org}'s MCP allow list`);
  }
}

/** role.md = project context, then the rules the role must follow, then its instructions core → project. */
function renderRoleMd(context: string, role: ResolvedRole): string {
  const list = (title: string, items: string[] | undefined) => (items?.length ? [`## ${title}`, ...items.map((i) => `- ${i}`), ""] : []);
  return [
    context,
    "",
    `# Role: ${role.id}${role.writes ? "" : " (read-only: never modify files)"}`,
    "",
    ...list("Must not", role.mustNot),
    ...list("Never modify these paths", role.readOnlyPaths),
    ...list("MCP servers you may use (no others)", role.mcp),
    ...role.instructions.flatMap((i) => [`<!-- ${i.origin} -->`, i.text, ""]),
  ].join("\n");
}

/** Resolves a role for an org project and writes the generated agent under agents/<org>/<project>/<role>/. */
export function roleAdd(root: string, core: string, ref: string, roleId: string): ResolvedRole {
  const { org, project } = parseRef(ref);
  checkId("role", roleId);
  const p = readProject(root, org, project);
  const orgDir = join(root, "orgs", org);
  const role = mergeChain(
    loadChain({ core: join(core, "workflow", "roles"), org: join(orgDir, "roles"), project: join(orgDir, "projects", project, "roles") }, roleId),
  );
  checkMcp(root, org, role);

  const orgFile = yaml(join(orgDir, "org.yml"));
  const hosts: unknown = orgFile && typeof orgFile === "object" ? Reflect.get(orgFile, "hosts") : undefined;
  const tracker: unknown = orgFile && typeof orgFile === "object" ? Reflect.get(orgFile, "tracker") : undefined;
  const hostLines = Array.isArray(hosts)
    ? hosts.flatMap((h: unknown) => (h && typeof h === "object" ? [`- ${String(Reflect.get(h, "match"))} → ${String(Reflect.get(h, "prTool"))}`] : []))
    : [];
  const rulesDir = join(orgDir, "rules");
  const ruleFiles = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".md") && f !== "README.md").sort().map((f) => join(rulesDir, f)) : [];
  const context = [
    ...[join(orgDir, "AGENTS.md"), ...ruleFiles, join(orgDir, "projects", project, "context.md"), join(orgDir, "projects", project, "glossary.md")]
      .filter(existsSync)
      .map((f) => readFileSync(f, "utf8").trim()),
    ...(hostLines.length ? [["## Code hosts (pull-request tool)", ...hostLines].join("\n")] : []),
    ...(typeof tracker === "string" && tracker !== "none" ? [`Tracker: ${tracker}`] : []),
  ].join("\n\n");
  const dir = join(root, "agents", org, project, roleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.md"), renderRoleMd(context, role));

  const approval: Record<string, string> = {};
  for (const tool of role.tools.prompt) approval[tool] = "prompt";
  for (const tool of [...role.tools.deny, ...(role.writes ? [] : FILE_WRITERS)]) approval[tool] = "deny";
  // Read-only roles deny `write`; omp routes MCP calls through `write xd://…` unless tools.xdev is off.
  writeYaml(join(dir, "overlay.yml"), { tools: { approval, ...(role.writes ? {} : { xdev: false }) } });

  const cwd = defaultRepoDir(root, org, p);
  const model = role.model?.tier ? loadWorkspace(root).models?.[role.model.tier] : undefined;
  const omp = `omp --cwd ${shq(cwd)} --append-system-prompt ${shq(join(dir, "role.md"))} --config ${shq(join(dir, "overlay.yml"))}${model ? ` --model ${shq(model)}` : ""}`;
  const { instructions: _instructions, ...definition } = role;
  writeYaml(join(dir, "agent.yml"), { ...definition, org, project, cwd, test: p.test ?? {}, launch: { omp } });

  const ws = loadWorkspace(root);
  const entry = ws.projects.find((x) => x.org === org && x.id === project);
  if (entry && !entry.roles.includes(roleId)) {
    entry.roles.push(roleId);
    saveWorkspace(root, ws);
  }
  return role;
}

const NOTE_KINDS: Record<string, string> = {
  decisions: "decisions",
  people: "people",
  projects: "projects",
  preferences: "preferences",
  followups: "follow-ups",
  inbox: "inbox",
  daily: "daily",
};

/** Folders containing .obsidian/ under home (at most 4 levels deep), plus Obsidian's iCloud folder on macOS. */
export function findVaults(home: string, depth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".obsidian" && e.isDirectory())) found.push(dir);
    if (level >= depth) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "Library") walk(join(dir, e.name), level + 1);
    }
  };
  walk(home, 0);
  walk(join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"), 2);
  return [...new Set(found)].sort();
}

/** Resolves a user-typed path: expands ~, resolves against the caller's folder, refuses the tool folder itself. */
function userPath(root: string, path: string, cwd: string, core: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const full = resolve(cwd, expanded);
  for (const folder of [root, join(core, "..")]) {
    const rel = relative(resolve(folder), full);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error(`${full} is inside the tool folder; keep notes outside it (they would end up in the public repo)`);
    }
  }
  return full;
}

/** Uses an existing vault: maps workflow note kinds to its top-level folders by name, records it. Moves nothing. */
export function useVault(root: string, path: string, cwd: string, core: string) {
  const full = userPath(root, path, cwd, core);
  if (!existsSync(full)) throw new Error(`${full} does not exist; use ./setup vault new to create it`);
  const dirs = readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  const folders: Record<string, string> = {};
  for (const [kind, name] of Object.entries(NOTE_KINDS)) {
    const match = dirs.find((d) => d.toLowerCase() === name);
    if (match) folders[kind] = match;
  }
  if (existsSync(join(full, "_index.md"))) folders.index = "_index.md";
  const notes = { kind: "vault" as const, path: full, folders };
  const ws = loadWorkspace(root);
  ws.notes = notes;
  saveWorkspace(root, ws);
  return notes;
}

/** Creates the default vault structure without overwriting existing files, then uses it. */
export function newVault(root: string, path: string, core: string, cwd: string) {
  const full = userPath(root, path, cwd, core);
  mkdirSync(full, { recursive: true });
  cpSync(join(core, "templates", "notes"), full, { recursive: true, force: false, errorOnExist: false });
  return useVault(root, full, cwd, core);
}

export interface Check {
  check: string;
  ok: boolean;
  detail?: string;
}

/** Files tracked by the tool repo that contain one of an org's deny words (case-insensitive). */
function denyWordHits(root: string, org: string): string[] {
  const words = stringListFromLines(join(root, "orgs", org, "denywords.txt"));
  if (!words.length || !existsSync(join(root, ".git"))) return [];
  const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  return files.filter((f) => {
    const file = join(root, f);
    return existsSync(file) && words.some((w) => readFileSync(file, "utf8").toLowerCase().includes(w));
  });
}

function stringListFromLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"));
}

/** Checks the workspace on disk: tools, orgs, projects, generated agents, vault, org words in the tool repo. */
export function verify(root: string): Check[] {
  const ws = loadWorkspace(root);
  const checks: Check[] = [];
  for (const tool of ["git", ws.tools?.agent ?? "omp"]) checks.push({ check: `${tool} installed`, ok: Bun.which(tool) !== null });
  for (const o of ws.orgs) {
    checks.push({ check: `org ${o.id} present`, ok: existsSync(join(root, "orgs", o.id, "org.yml")) });
    const hits = denyWordHits(root, o.id);
    checks.push({ check: `no org ${o.id} words in the tool repo`, ok: hits.length === 0, detail: hits.join(", ") });
  }
  for (const p of ws.projects) {
    let repoDir: string;
    try {
      repoDir = defaultRepoDir(root, p.org, readProject(root, p.org, p.id));
    } catch (e) {
      checks.push({ check: `project ${p.org}/${p.id} defined`, ok: false, detail: (e as Error).message });
      continue;
    }
    checks.push({ check: `project ${p.org}/${p.id} cloned`, ok: existsSync(repoDir), detail: repoDir });
    for (const r of p.roles) {
      checks.push({ check: `agent ${p.org}/${p.id}/${r} generated`, ok: existsSync(join(root, "agents", p.org, p.id, r, "agent.yml")) });
    }
  }
  if (ws.notes?.kind === "vault" && ws.notes.path) {
    for (const [kind, folder] of Object.entries(ws.notes.folders ?? {})) {
      checks.push({ check: `vault ${kind} (${folder}) exists`, ok: existsSync(join(ws.notes.path, folder)) });
    }
  }
  return checks;
}
