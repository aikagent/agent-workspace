#!/usr/bin/env bun
/**
 * agent-workspace setup.
 *   ./setup                          the setup wizard: tools, sign-in, org, import, projects, agents, context, MCP, routing, delegation, vault, verify;
 *                                    resumes where it stopped and ends by offering the Main session (omp in this folder)
 *   ./setup check                    show which tools are installed
 *   ./setup org add <git-url>        clone an org repo into orgs/<id>
 *   ./setup project add <org>/<p>    set up an org project's repos in projects/<org>/<name>/ (clone, or empty folder without a url)
 *   ./setup role add <org>/<p> <r>   resolve a role (core → org → project) and generate its agent
 *   ./setup vault find|use <path>|new <path>
 *   ./setup routing show             signed-in providers with their usage, and the workspace routing (off by default)
 *   ./setup routing set <role> <provider/model>...   models for an omp model role, in preference order (turns routing on)
 *   ./setup routing limits <short%> <week%>          percent used at which a provider is skipped (default 95 80)
 *   ./setup routing off              agents go back to your own omp setup
 *   ./setup delegation on|off|show   Main can hand work to project agents (turns the delegation extension on in every agent launch)
 *   ./setup verify                   check the workspace on disk
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnRunner, usage, usageLines } from "./src/omp";
import { delegationChecks, delegationOff, delegationOn, ternLinkCommand } from "./src/delegation";
import { passChecks } from "./src/pass";
import { runWizard } from "./src/tui";
import { findVaults, loadWorkspace, newVault, orgAdd, projectAdd, roleAdd, routingLimits, routingOff, routingSet, useVault, verify } from "./src/workspace";

const CORE = join(import.meta.dir, "..");
/** AGENT_WORKSPACE_ROOT points the commands at another workspace (used by tests and smoke runs). */
const ROOT = process.env.AGENT_WORKSPACE_ROOT ?? join(CORE, "..");
if (process.env.AGENT_WORKSPACE_ROOT) console.error(`workspace: ${ROOT} (from AGENT_WORKSPACE_ROOT)`);
/** The folder ./setup was called from (the script cds to the tool root), for user-typed paths. */
const CALLER_CWD = process.env.AGENT_WORKSPACE_CALLER_CWD ?? process.cwd();
const TOOLS = ["git", "omp", "tern", "pass"];

function check(): void {
  for (const t of TOOLS) console.log(`${Bun.which(t) ? "✓" : "·"} ${t}${Bun.which(t) ? "" : " (not found)"}`);
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : Bun.YAML.stringify(value, null, 2));
}

async function main(args: string[]): Promise<void> {
  const [cmd, sub, a, b] = args;
  switch (`${cmd ?? ""} ${["org", "project", "role", "vault", "routing", "delegation"].includes(cmd ?? "") ? sub ?? "" : ""}`.trim()) {
    case "":
      return runWizard({ root: ROOT, core: CORE, callerCwd: CALLER_CWD, home: homedir(), run: spawnRunner });
    case "check":
      return void check();
    case "routing show":
      return print({ routing: loadWorkspace(ROOT).routing ?? "off", usage: usageLines(usage(spawnRunner, ROOT) ?? []) });
    case "routing set":
      return print(routingSet(ROOT, CORE, need(a, "model role"), args.slice(3)));
    case "routing limits":
      return print(routingLimits(ROOT, CORE, Number(need(a, "short%")), Number(need(b, "week%"))));
    case "routing off":
      routingOff(ROOT, CORE);
      return print("routing off");
    case "delegation on":
      delegationOn(ROOT, CORE);
      return print(`delegation on; link the Tern plugin once: ${ternLinkCommand(CORE)}`);
    case "delegation off":
      delegationOff(ROOT, CORE);
      return print("delegation off");
    case "delegation show":
      return print(delegationChecks(ROOT, CORE, homedir(), spawnRunner).map((c) => `${c.ok ? "✓" : "✗"} ${c.check}${c.detail && !c.ok ? ` — ${c.detail}` : ""}`).join("\n"));
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
      const checks = [...verify(ROOT), ...delegationChecks(ROOT, CORE, homedir(), spawnRunner), ...passChecks(homedir(), process.env)];
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
  await main(process.argv.slice(2));
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
