import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./workspace";

/** The pass store folder when it is set up (has a .gpg-id), else undefined. */
export function passStore(home: string, env: Record<string, string | undefined>): string | undefined {
  const dir = env.PASSWORD_STORE_DIR ?? join(home, ".password-store");
  return existsSync(join(dir, ".gpg-id")) ? dir : undefined;
}

/** `!pass show <path>` references in omp's user MCP config, per server. */
function mcpPassRefs(home: string): { server: string; path: string }[] {
  const file = join(home, ".omp", "agent", "mcp.json");
  if (!existsSync(file)) return [];
  let servers: Record<string, Record<string, unknown>>;
  try {
    servers = JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {};
  } catch {
    return [];
  }
  return Object.entries(servers).flatMap(([server, entry]) =>
    ["env", "headers"].flatMap((field) =>
      Object.values((entry?.[field] as Record<string, unknown> | undefined) ?? {}).flatMap((v) => {
        const path = typeof v === "string" ? v.match(/^!pass show (\S+)$/)?.[1] : undefined;
        return path ? [{ server, path }] : [];
      }),
    ),
  );
}

/** One check per pass reference in omp's MCP config: the entry exists in the store (by file name; never read). */
export function passChecks(home: string, env: Record<string, string | undefined>): Check[] {
  const store = passStore(home, env);
  return mcpPassRefs(home).map(({ server, path }) => {
    const check = `pass has ${path} (MCP ${server})`;
    if (!store) return { check, ok: false, detail: "pass is not set up: install it and run pass init <gpg-id>" };
    return existsSync(join(store, `${path}.gpg`)) ? { check, ok: true } : { check, ok: false, detail: `run: pass insert ${path}` };
  });
}
