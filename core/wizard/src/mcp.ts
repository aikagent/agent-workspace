import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A server configured for another agent. `entry` stays in memory; callers show name and source only. */
export interface Found {
  name: string;
  source: string;
  entry: Record<string, unknown>;
}

/** Config file (relative to home) → key holding its MCP servers. */
const SOURCES: [string, string][] = [
  [".claude.json", "mcpServers"],
  [".cursor/mcp.json", "mcpServers"],
  [".gemini/settings.json", "mcpServers"],
  [".codeium/windsurf/mcp_config.json", "mcpServers"],
  ["Library/Application Support/Code/User/mcp.json", "servers"],
  [".config/Code/User/mcp.json", "servers"],
  [".config/opencode/opencode.json", "mcp"],
  [".codex/config.toml", "mcp_servers"],
];

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** MCP servers configured for other agents on this machine; unreadable or invalid files are skipped. */
export function scanServers(home: string): Found[] {
  return SOURCES.flatMap(([rel, key]) => {
    const source = join(home, rel);
    if (!existsSync(source)) return [];
    try {
      const text = readFileSync(source, "utf8");
      const parsed = (rel.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text)) as Record<string, unknown>;
      let servers = parsed?.[key];
      // OpenCode's newer layout nests servers one level down: { mcp: { servers: { … } } }.
      if (isMap(servers) && isMap(servers.servers) && Object.values(servers.servers).every(isMap)) servers = servers.servers;
      if (!isMap(servers)) return [];
      return Object.entries(servers)
        .filter(([, entry]) => isMap(entry))
        .map(([name, entry]) => ({ name, source, entry: entry as Record<string, unknown> }));
    } catch {
      return [];
    }
  });
}

/** Keys translated below, plus keys other tools use that carry no secret and have no omp equivalent (dropped). */
const ACCEPTED: Record<string, true> = {
  type: true,
  command: true,
  args: true,
  url: true,
  serverUrl: true,
  httpUrl: true,
  env: true,
  environment: true,
  headers: true,
  http_headers: true,
  bearer_token_env_var: true,
  cwd: true,
  enabled: true,
  disabled: true,
  timeout: true,
  startup_timeout_sec: true,
  tool_timeout_sec: true,
  trust: true,
  autoApprove: true,
  alwaysAllow: true,
  description: true,
};

/** A value that already points at its secret (an omp command or a ${VAR} reference) instead of holding it. */
const isReference = (v: unknown) => typeof v === "string" && (v.startsWith("!") || v.includes("${"));

export type Imported = { entry: Record<string, unknown>; store: string[] } | { skip: string };

/**
 * Converts a server from another tool's format to omp's (type, command, args, url, env, headers, cwd), with every env
 * and header value replaced by a reference: a pass command, or (without pass) a per-server variable name that omp reads
 * from the environment. `store` lists what the engineer still has to store. Entries that could carry a secret in a
 * field this conversion does not know are skipped rather than copied.
 */
export function toOmp(name: string, raw: Record<string, unknown>, secrets: "pass" | "env", prefix: string): Imported {
  for (const [k, v] of Object.entries(raw)) {
    if (ACCEPTED[k]) continue;
    if (typeof v === "string" || isMap(v) || Array.isArray(v)) return { skip: `has "${k}", which may hold a secret; add it to omp by hand` };
  }
  const url = [raw.url, raw.serverUrl, raw.httpUrl].find((v) => typeof v === "string") as string | undefined;
  const cmd = Array.isArray(raw.command) ? raw.command.map(String) : typeof raw.command === "string" ? [raw.command] : [];
  if (!url && !cmd.length) return { skip: "has no command or url" };

  const entry: Record<string, unknown> = url ? { type: raw.type === "sse" ? "sse" : "http", url } : { type: "stdio", command: cmd[0] };
  const args = [...cmd.slice(1), ...(Array.isArray(raw.args) ? raw.args.map(String) : [])];
  if (!url && args.length) entry.args = args;
  if (typeof raw.cwd === "string") entry.cwd = raw.cwd;

  const store: string[] = [];
  const varName = (k: string) => `${name}_${k}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const refs = (values: unknown, hint: string): Record<string, unknown> | undefined => {
    if (!isMap(values)) return undefined;
    return Object.fromEntries(
      Object.entries(values).map(([k, v]) => {
        if (isReference(v)) return [k, v];
        if (secrets === "pass") {
          store.push(`pass insert ${prefix}/${name}/${k}${hint && k.toLowerCase() === "authorization" ? `   # ${hint}` : ""}`);
          return [k, `!pass show ${prefix}/${name}/${k}`];
        }
        store.push(`export ${varName(k)}='<full value>'`);
        return [k, varName(k)];
      }),
    );
  };
  const env = refs(raw.env ?? raw.environment, "");
  const headers = refs(raw.headers ?? raw.http_headers, 'the full value, e.g. "Bearer <token>"') ?? {};
  if (typeof raw.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${raw.bearer_token_env_var}}`;
  if (env && Object.keys(env).length) entry.env = env;
  if (Object.keys(headers).length) entry.headers = headers;
  return { entry, store };
}

/** Adds a server to omp's user mcp.json (created when missing); refuses to replace an existing server. */
export function addToOmp(file: string, name: string, entry: Record<string, unknown>): void {
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  config.mcpServers ??= {};
  if (name in config.mcpServers) throw new Error(`${name} already exists in ${file}`);
  config.mcpServers[name] = entry;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
