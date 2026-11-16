import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Role {
  id: string;
  extends?: string;
  description?: string;
  writes?: boolean;
  model?: { tier?: string };
  thinking?: string;
  tools?: { allow?: string[]; deny?: string[]; prompt?: string[] };
  readOnlyPaths?: string[];
  mustNot?: string[];
  mcp?: string[];
  skills?: string[];
}

export interface RoleLayer {
  origin: string; // "core:dev", "org:dev", "project:dev"
  role: Role;
  instructions: string;
}

export interface ResolvedRole {
  id: string;
  description?: string;
  writes: boolean;
  model?: { tier?: string };
  thinking?: string;
  tools: { allow: string[]; deny: string[]; prompt: string[] };
  readOnlyPaths: string[];
  mustNot: string[];
  mcp?: string[];
  skills?: string[];
  instructions: { origin: string; text: string }[];
  chain: string[];
}

const union = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];

function narrow(field: "mcp" | "skills", parent: string[] | undefined, child: string[] | undefined, origin: string) {
  if (child === undefined) return parent;
  if (parent === undefined) return child;
  const extra = child.filter((x) => !parent.includes(x));
  if (extra.length) throw new Error(`${origin}: ${field} adds ${extra.join(", ")}, which the parent does not allow`);
  return child;
}

/** Merges layers ordered core → org → project. Lower layers can only tighten. */
export function mergeChain(layers: RoleLayer[]): ResolvedRole {
  const [base, ...rest] = layers;
  const r: ResolvedRole = {
    id: base.role.id,
    description: base.role.description,
    writes: base.role.writes ?? false,
    model: base.role.model,
    thinking: base.role.thinking,
    tools: { allow: base.role.tools?.allow ?? [], deny: base.role.tools?.deny ?? [], prompt: base.role.tools?.prompt ?? [] },
    readOnlyPaths: base.role.readOnlyPaths ?? [],
    mustNot: base.role.mustNot ?? [],
    mcp: base.role.mcp,
    skills: base.role.skills,
    instructions: [{ origin: base.origin, text: base.instructions }],
    chain: [base.origin],
  };
  for (const { origin, role, instructions } of rest) {
    if (role.tools?.allow?.length) throw new Error(`${origin}: tools.allow can only be set in core`);
    if (role.writes === true && !r.writes) throw new Error(`${origin}: cannot set writes: true on a read-only parent`);
    if (role.writes === false) r.writes = false;
    r.id = role.id;
    r.description = role.description ?? r.description;
    r.model = role.model ?? r.model;
    r.thinking = role.thinking ?? r.thinking;
    r.tools.deny = union(r.tools.deny, role.tools?.deny);
    r.tools.prompt = union(r.tools.prompt, role.tools?.prompt);
    r.readOnlyPaths = union(r.readOnlyPaths, role.readOnlyPaths);
    r.mustNot = union(r.mustNot, role.mustNot);
    r.mcp = narrow("mcp", r.mcp, role.mcp, origin);
    r.skills = narrow("skills", r.skills, role.skills, origin);
    r.instructions.push({ origin, text: instructions });
    r.chain.push(origin);
  }
  return r;
}

export interface RoleDirs {
  core: string; // core/workflow/roles
  org?: string; // orgs/<org>/roles
  project?: string; // orgs/<org>/projects/<project>/roles
}

const LIST_FIELDS = ["readOnlyPaths", "mustNot", "mcp", "skills"] as const;
const TOOL_LISTS = ["allow", "deny", "prompt"] as const;

const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validates a parsed role.yml; YAML turns `deny: bash` into a string and `writes: no` into "no", so check types. */
function parseRole(yml: string, raw: unknown): Role {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${yml}: role.yml is empty or not a mapping`);
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") throw new Error(`${yml}: id must be a string`);
  if (r.extends !== undefined && typeof r.extends !== "string") throw new Error(`${yml}: extends must be "<level>:<role>"`);
  if (r.writes !== undefined && typeof r.writes !== "boolean") throw new Error(`${yml}: writes must be true or false`);
  for (const f of LIST_FIELDS) if (r[f] !== undefined && !isStringList(r[f])) throw new Error(`${yml}: ${f} must be a list of strings`);
  if (r.tools !== undefined) {
    if (!r.tools || typeof r.tools !== "object") throw new Error(`${yml}: tools must be a mapping`);
    const tools = r.tools as Record<string, unknown>;
    for (const f of TOOL_LISTS) if (tools[f] !== undefined && !isStringList(tools[f])) throw new Error(`${yml}: tools.${f} must be a list of strings`);
  }
  return r as unknown as Role; // shape checked field by field above
}

function readLayer(dir: string, id: string, level: string): RoleLayer | undefined {
  const yml = join(dir, id, "role.yml");
  if (!existsSync(yml)) return undefined;
  const role = parseRole(yml, Bun.YAML.parse(readFileSync(yml, "utf8")));
  if (role.id !== id) throw new Error(`${yml}: id is "${role.id}", expected "${id}"`);
  const md = join(dir, id, "role.md");
  return { origin: `${level}:${id}`, role, instructions: existsSync(md) ? readFileSync(md, "utf8").trim() : "" };
}

/** Finds the most specific definition of `id` and follows `extends` down to a core role. */
export function loadChain(dirs: RoleDirs, id: string): RoleLayer[] {
  const levels: [string, string | undefined][] = [["project", dirs.project], ["org", dirs.org], ["core", dirs.core]];
  let layer: RoleLayer | undefined;
  for (const [level, dir] of levels) {
    if (dir) layer = readLayer(dir, id, level);
    if (layer) break;
  }
  if (!layer) throw new Error(`role "${id}" is not defined at any level`);
  const chain = [layer];
  while (chain[0].role.extends) {
    const ref = chain[0].role.extends;
    const [level, parentId] = ref.split(":");
    const index = levels.findIndex(([l]) => l === level);
    const from = levels.findIndex(([l]) => l === chain[0].origin.split(":")[0]);
    if (index <= from || !parentId) {
      throw new Error(`${chain[0].origin}: extends "${ref}" must point to a more general level (project → org → core)`);
    }
    for (let i = from + 1; i < index; i++) {
      const [skipped, skippedDir] = levels[i];
      if (skippedDir && readLayer(skippedDir, parentId, skipped)) {
        throw new Error(`${chain[0].origin}: extends ${ref} but ${skipped}:${parentId} exists; extend ${skipped}:${parentId}`);
      }
    }
    const dir = levels[index][1];
    const parent = dir ? readLayer(dir, parentId, level) : undefined;
    if (!parent) throw new Error(`${chain[0].origin}: extends "${ref}", which does not exist`);
    chain.unshift(parent);
  }
  if (!chain[0].origin.startsWith("core:")) throw new Error(`${chain[0].origin}: every role must extend a core role`);
  // A role may rename its base (support → extends core:dev) only if no more general level defines its own id;
  // otherwise that level's restrictions would be dropped.
  const top = chain[chain.length - 1].origin;
  const origins = new Set(chain.map((l) => l.origin));
  for (const [level, dir] of levels.slice(levels.findIndex(([l]) => l === top.split(":")[0]) + 1)) {
    if (dir && !origins.has(`${level}:${id}`) && readLayer(dir, id, level)) throw new Error(`${top}: must build on ${level}:${id}`);
  }
  return chain;
}
