import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToOmp, scanServers, toOmp } from "../src/mcp";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aw-mcp-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const put = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const SECRET = "s3cret-value";

describe("scanServers", () => {
  test("reads server names from each agent's config format and skips unreadable files", () => {
    put(".claude.json", JSON.stringify({ mcpServers: { tracker: { type: "http", url: "https://t.example" } } }));
    put(".codex/config.toml", '[mcp_servers.docs]\ncommand = "docs-mcp"\n');
    put(".config/opencode/opencode.json", JSON.stringify({ mcp: { chat: { type: "remote", url: "https://c.example" } } }));
    put(".gemini/settings.json", "{ not json");
    expect(scanServers(home).map((f) => [f.name, f.source])).toEqual([
      ["tracker", join(home, ".claude.json")],
      ["chat", join(home, ".config/opencode/opencode.json")],
      ["docs", join(home, ".codex/config.toml")],
    ]);
  });

  test("reads OpenCode's nested mcp.servers layout", () => {
    put(".config/opencode/opencode.json", JSON.stringify({ mcp: { servers: { jira: { type: "local", command: ["jira-mcp"] } } } }));
    expect(scanServers(home).map((f) => f.name)).toEqual(["jira"]);
  });
});

describe("toOmp", () => {
  const imported = (name: string, raw: Record<string, unknown>, secrets: "pass" | "env" = "pass") => {
    const r = toOmp(name, raw, secrets, "mcp");
    if ("skip" in r) throw new Error(`skipped: ${r.skip}`);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    return r;
  };

  test("Claude/Cursor shape: env and header values become pass references", () => {
    const r = imported("tracker", { type: "http", url: "https://t.example", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(r.entry).toEqual({ type: "http", url: "https://t.example", headers: { Authorization: "!pass show mcp/tracker/Authorization" } });
    expect(r.store).toEqual(['pass insert mcp/tracker/Authorization   # the full value, e.g. "Bearer <token>"']);
  });

  test("OpenCode shape: local command array and environment map", () => {
    const r = imported("jira", { type: "local", command: ["npx", "-y", "jira-mcp"], environment: { JIRA_TOKEN: SECRET } });
    expect(r.entry).toEqual({ type: "stdio", command: "npx", args: ["-y", "jira-mcp"], env: { JIRA_TOKEN: "!pass show mcp/jira/JIRA_TOKEN" } });
    expect(imported("chat", { type: "remote", url: "https://c.example" }).entry).toEqual({ type: "http", url: "https://c.example" });
  });

  test("Codex shape: http_headers and a bearer token already kept in an environment variable", () => {
    const r = imported("docs", { url: "https://d.example", http_headers: { "X-Key": SECRET }, bearer_token_env_var: "DOCS_TOKEN" });
    expect(r.entry).toEqual({
      type: "http",
      url: "https://d.example",
      headers: { "X-Key": "!pass show mcp/docs/X-Key", Authorization: "Bearer ${DOCS_TOKEN}" },
    });
  });

  test("Windsurf and Gemini remote URLs", () => {
    expect(imported("w", { serverUrl: "https://w.example" }).entry).toEqual({ type: "http", url: "https://w.example" });
    expect(imported("g", { httpUrl: "https://g.example" }).entry).toEqual({ type: "http", url: "https://g.example" });
  });

  test("without pass, each value gets its own shell-safe variable name", () => {
    const r = imported("my-tracker", { url: "https://t.example", headers: { "X-API-Key": SECRET } }, "env");
    expect(r.entry).toEqual({ type: "http", url: "https://t.example", headers: { "X-API-Key": "MY_TRACKER_X_API_KEY" } });
    expect(r.store).toEqual(["export MY_TRACKER_X_API_KEY='<full value>'"]);
  });

  test("an entry without env or headers is copied as is", () => {
    expect(imported("plain", { command: "docs-mcp", args: ["--x"] })).toEqual({ entry: { type: "stdio", command: "docs-mcp", args: ["--x"] }, store: [] });
  });

  test("an entry with a field that could hold a secret, or nothing to run, is skipped", () => {
    expect(toOmp("slack", { url: "https://s.example", oauth: { clientSecret: SECRET } }, "pass", "mcp")).toEqual({
      skip: 'has "oauth", which may hold a secret; add it to omp by hand',
    });
    expect(toOmp("empty", { type: "http" }, "pass", "mcp")).toEqual({ skip: "has no command or url" });
  });
});

describe("addToOmp", () => {
  test("creates the file when missing, adds new servers, never overwrites one", () => {
    const file = join(home, ".omp", "agent", "mcp.json");
    addToOmp(file, "docs", { command: "docs-mcp" });
    addToOmp(file, "chat", { url: "https://c.example" });
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).toEqual({ docs: { command: "docs-mcp" }, chat: { url: "https://c.example" } });
    expect(() => addToOmp(file, "docs", { command: "other" })).toThrow("docs already exists in");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.docs).toEqual({ command: "docs-mcp" });
  });
});
