import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passChecks, passStore } from "../src/pass";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aw-pass-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ompMcp = (servers: Record<string, unknown>) => {
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "mcp.json"), JSON.stringify({ mcpServers: servers }));
};
const passEntry = (store: string, path: string) => {
  mkdirSync(join(store, path, ".."), { recursive: true });
  writeFileSync(join(store, `${path}.gpg`), "");
};

describe("passStore", () => {
  test("the store is set up once it has a .gpg-id; PASSWORD_STORE_DIR moves it", () => {
    expect(passStore(home, {})).toBeUndefined();
    mkdirSync(join(home, ".password-store"));
    writeFileSync(join(home, ".password-store", ".gpg-id"), "ABC\n");
    expect(passStore(home, {})).toBe(join(home, ".password-store"));
    expect(passStore(home, { PASSWORD_STORE_DIR: join(home, "elsewhere") })).toBeUndefined();
  });
});

describe("passChecks", () => {
  test("every pass reference in omp's MCP config must exist in the store, by name", () => {
    const store = join(home, ".password-store");
    mkdirSync(store);
    writeFileSync(join(store, ".gpg-id"), "ABC\n");
    passEntry(store, "work/acme/mcp/tracker/Authorization");
    ompMcp({
      tracker: { url: "https://t.example", headers: { Authorization: "!pass show work/acme/mcp/tracker/Authorization" } },
      jira: { command: "jira-mcp", env: { JIRA_TOKEN: "!pass show work/acme/mcp/jira/JIRA_TOKEN", MODE: "plain" } },
    });
    expect(passChecks(home, {})).toEqual([
      { check: "pass has work/acme/mcp/tracker/Authorization (MCP tracker)", ok: true },
      { check: "pass has work/acme/mcp/jira/JIRA_TOKEN (MCP jira)", ok: false, detail: "run: pass insert work/acme/mcp/jira/JIRA_TOKEN" },
    ]);
  });

  test("without a set-up store, each reference fails with how to set it up; no MCP config means no checks", () => {
    expect(passChecks(home, {})).toEqual([]);
    ompMcp({ jira: { command: "jira-mcp", env: { JIRA_TOKEN: "!pass show work/acme/mcp/jira/JIRA_TOKEN" } } });
    expect(passChecks(home, {})).toEqual([
      { check: "pass has work/acme/mcp/jira/JIRA_TOKEN (MCP jira)", ok: false, detail: "pass is not set up: install it and run pass init <gpg-id>" },
    ]);
  });
});
