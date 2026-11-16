import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToOmp, scanServers, withReferences } from "../src/mcp";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aw-mcp-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const put = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};

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
});

describe("withReferences", () => {
  test("replaces env and header values with references and keeps the rest", () => {
    const entry = { type: "http", url: "https://t.example", headers: { Authorization: "Bearer s3cret" }, env: { TOKEN: "s3cret" } };
    expect(withReferences("tracker", entry, "pass", "mcp")).toEqual({
      type: "http",
      url: "https://t.example",
      headers: { Authorization: "!pass show mcp/tracker/Authorization" },
      env: { TOKEN: "!pass show mcp/tracker/TOKEN" },
    });
    expect(withReferences("tracker", { env: { TOKEN: "x" } }, "env", "mcp")).toEqual({ env: { TOKEN: "${TOKEN}" } });
  });

  test("an entry without env or headers is copied as is", () => {
    expect(withReferences("plain", { command: "docs-mcp", args: ["--x"] }, "pass", "mcp")).toEqual({ command: "docs-mcp", args: ["--x"] });
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
