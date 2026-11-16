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

/** MCP servers configured for other agents on this machine; unreadable or invalid files are skipped. */
export function scanServers(home: string): Found[] {
  return SOURCES.flatMap(([rel, key]) => {
    const source = join(home, rel);
    if (!existsSync(source)) return [];
    try {
      const text = readFileSync(source, "utf8");
      const parsed = (rel.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text)) as Record<string, unknown>;
      const servers = parsed?.[key];
      if (!servers || typeof servers !== "object") return [];
      return Object.entries(servers as Record<string, Record<string, unknown>>).map(([name, entry]) => ({ name, source, entry }));
    } catch {
      return [];
    }
  });
}

/** The entry with every env and header value replaced by a reference (pass command, or the variable's name, which omp reads from the environment). */
export function withReferences(name: string, entry: Record<string, unknown>, secrets: "pass" | "env", prefix: string): Record<string, unknown> {
  const ref = (k: string) => (secrets === "pass" ? `!pass show ${prefix}/${name}/${k}` : k);
  const out: Record<string, unknown> = { ...entry };
  for (const field of ["env", "headers"]) {
    const values = entry[field];
    if (values && typeof values === "object") out[field] = Object.fromEntries(Object.keys(values).map((k) => [k, ref(k)]));
  }
  return out;
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
