#!/usr/bin/env bun
/**
 * agent-workspace setup.
 *   ./setup                          bootstrap: AI provider, agent, smoke test, then hand over to the agent (/workspace-setup)
 *   ./setup check                    show which tools are installed
 *   ./setup org add <git-url>        clone an org repo into orgs/<id>
 *   ./setup project add <org>/<p>    set up an org project's repos in projects/<org>/<name>/ (clone, or empty folder without a url)
 *   ./setup role add <org>/<p> <r>   resolve a role (core → org → project) and generate its agent
 *   ./setup vault find|use <path>|new <path>
 *   ./setup verify                   check the workspace on disk
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findVaults, loadWorkspace, newVault, orgAdd, projectAdd, roleAdd, saveWorkspace, useVault, verify } from "./src/workspace";

const CORE = join(import.meta.dir, "..");
/** AGENT_WORKSPACE_ROOT points the commands at another workspace (used by tests and smoke runs). */
const ROOT = process.env.AGENT_WORKSPACE_ROOT ?? join(CORE, "..");
if (process.env.AGENT_WORKSPACE_ROOT) console.error(`workspace: ${ROOT} (from AGENT_WORKSPACE_ROOT)`);
/** The folder ./setup was called from (the script cds to the tool root), for user-typed paths. */
const CALLER_CWD = process.env.AGENT_WORKSPACE_CALLER_CWD ?? process.cwd();
const TOOLS = ["git", "omp", "tern", "pass"];

function run(cmd: string, args: string[], opts: { inherit?: boolean } = {}): boolean {
  // Pass env explicitly: in Bun, changes to process.env do not reach child processes otherwise.
  const r = spawnSync(cmd, args, { cwd: ROOT, env: process.env, stdio: opts.inherit ? "inherit" : "pipe", encoding: "utf8" });
  if (r.error) console.error(`${cmd}: ${r.error.message}`);
  else if (r.status !== 0 && !opts.inherit && r.stderr) console.error(r.stderr.trim().split("\n").slice(-5).join("\n"));
  return r.status === 0;
}

function check(): Record<string, boolean> {
  const found = Object.fromEntries(TOOLS.map((t) => [t, Bun.which(t) !== null]));
  for (const [tool, ok] of Object.entries(found)) console.log(`${ok ? "✓" : "·"} ${tool}${ok ? "" : " (not found)"}`);
  return found;
}

function ask(question: string, fallback: string): string {
  return (prompt(`${question} [${fallback}]`) ?? "").trim() || fallback;
}

function bootstrap(): void {
  console.log("agent-workspace setup\n\n1. Tools on this machine");
  const found = check();
  if (!found.git) throw new Error("git is required");

  console.log("\n2. AI provider");
  const provider = ask("Which provider do you sign in with? (e.g. anthropic, openai-codex; empty = pick from the list)", "");

  console.log("\n3. Agent");
  const agent = ask("Agent to use (omp is the default; anything else gets the generic setup)", "omp");
  if (agent !== "omp") {
    const ws = loadWorkspace(ROOT);
    ws.tools = { ...ws.tools, agent };
    saveWorkspace(ROOT, ws);
    console.log(
      `\nGeneric setup for "${agent}": run these, then open your agent in a project folder.\n` +
        "  ./setup org add <git-url>\n  ./setup project add <org>/<project>\n  ./setup role add <org>/<project> <role>\n  ./setup vault find\n  ./setup verify",
    );
    return;
  }
  if (!found.omp) {
    if (!confirm("omp is not installed. Install it with: curl -fsSL https://omp.sh/install | sh ?")) throw new Error("omp is required for the guided setup");
    if (!run("sh", ["-c", "curl -fsSL https://omp.sh/install | sh"], { inherit: true })) throw new Error("omp install failed");
    // The installer puts omp in $PI_INSTALL_DIR or ~/.local/bin and only prints a PATH hint; make it visible to this run.
    process.env.PATH = `${process.env.PI_INSTALL_DIR ?? join(homedir(), ".local", "bin")}:${process.env.PATH}`;
    if (!Bun.which("omp", { PATH: process.env.PATH })) {
      throw new Error("omp was installed but is not on PATH; add its folder (default ~/.local/bin) to PATH and run ./setup again");
    }
  }

  console.log("\n4. Sign-in and smoke test");
  const smoke = () => run("omp", ["-p", "--no-session", "Reply with exactly: OK"]);
  if (!smoke()) {
    console.log("No working provider yet; starting omp login.");
    run("omp", provider ? ["login", provider] : ["login"], { inherit: true });
    if (!smoke()) throw new Error("omp still cannot reach a model; run `omp login` and try again");
  }
  console.log("✓ omp answered");

  const ws = loadWorkspace(ROOT);
  ws.tools = { terminal: found.tern ? "tern" : "plain", secrets: found.pass ? "pass" : "env", ...ws.tools, agent: "omp" };
  saveWorkspace(ROOT, ws);

  console.log("\n5. Hand-over: omp will now guide the rest (orgs, projects, roles, MCP, vault).");
  if (confirm("Start omp with /workspace-setup now?")) run("omp", ["/workspace-setup"], { inherit: true });
  else console.log("Later, run `omp` in this folder and type /workspace-setup.");
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : Bun.YAML.stringify(value, null, 2));
}

function main(args: string[]): void {
  const [cmd, sub, a, b] = args;
  switch (`${cmd ?? ""} ${cmd === "org" || cmd === "project" || cmd === "role" || cmd === "vault" ? sub ?? "" : ""}`.trim()) {
    case "":
      return bootstrap();
    case "check":
      return void check();
    case "org add":
      return print(`added org ${orgAdd(ROOT, need(a, "git-url"), CORE)}`);
    case "project add": {
      const { dir, repos } = projectAdd(ROOT, need(a, "org/project"));
      const said = { cloned: "cloned", present: "already there, left as is", created: "created empty (no url: put its files there)" };
      for (const r of repos) console.log(`${r.name}: ${said[r.status]}`);
      return print(`agents run in ${dir}`);
    }
    case "role add":
      return print(roleAdd(ROOT, CORE, need(a, "org/project"), need(b, "role")));
    case "vault find":
      return print(findVaults(homedir()));
    case "vault use":
      return print(useVault(ROOT, need(a, "path"), CALLER_CWD, CORE));
    case "vault new":
      return print(newVault(ROOT, need(a, "path"), CORE, CALLER_CWD));
    case "verify": {
      const checks = verify(ROOT);
      for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.check}${c.detail && !c.ok ? ` — ${c.detail}` : ""}`);
      if (checks.some((c) => !c.ok)) process.exitCode = 1;
      return;
    }
    default:
      console.log(readFileSync(import.meta.path, "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
      process.exitCode = cmd === "help" || cmd === "--help" ? 0 : 1;
  }
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing <${name}>; see ./setup help`);
  return value;
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
