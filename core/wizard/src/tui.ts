/**
 * The ./setup wizard. Screens only: every change goes through the tested functions in workspace.ts, omp.ts, mcp.ts
 * and progress.ts. Progress is saved after each step, so an interrupted setup resumes where it stopped.
 */
import * as p from "@clack/prompts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addToOmp, scanServers, toOmp } from "./mcp";
import { CONTEXT_PROMPT, catalog, draft, hasOwnRouting, login, modelRoles, proposeRouting, smoke, usage, usageLines, type Runner } from "./omp";
import { passChecks, passStore } from "./pass";
import { STEPS, loadProgress, markDone, nextStep, restart, type Step } from "./progress";
import {
  findVaults,
  loadWorkspace,
  newVault,
  orgAdd,
  projectAdd,
  repoDir,
  roleAdd,
  routingLimits,
  routingClear,
  routingOff,
  routingSet,
  saveContext,
  saveWorkspace,
  useVault,
  verify,
} from "./workspace";

export interface Ctx {
  root: string;
  core: string;
  callerCwd: string;
  home: string;
  run: Runner;
}

const PAUSED = "Setup paused; run ./setup to continue";
/** Steps that need omp itself; skipped when the engineer uses another agent. */
const OMP_ONLY: Step[] = ["signin", "context", "mcp", "routing"];

/** Unwraps a prompt answer; Ctrl+C pauses the setup (progress up to the last finished step is kept). */
function answer<T>(v: T | symbol): T {
  if (p.isCancel(v)) {
    p.cancel(PAUSED);
    process.exit(0);
  }
  return v as T;
}

const yaml = (file: string): unknown => (existsSync(file) ? Bun.YAML.parse(readFileSync(file, "utf8")) : undefined);
const field = (o: unknown, key: string): unknown => (o && typeof o === "object" ? Reflect.get(o, key) : undefined);
const list = (o: unknown, key: string): string[] => {
  const v = field(o, key);
  return Array.isArray(v) ? v.map(String) : [];
};
const subdirs = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const usesOmp = (ctx: Ctx) => (loadWorkspace(ctx.root).tools?.agent ?? "omp") === "omp";

/** A typed path: expands ~ and resolves against the folder ./setup was called from; URLs pass through. */
function pathOrUrl(input: string, ctx: Ctx): string {
  const v = input.trim();
  if (v.includes("://") || /^[\w.-]+@[\w.-]+:/.test(v)) return v;
  const expanded = v === "~" ? ctx.home : v.startsWith("~/") ? join(ctx.home, v.slice(2)) : v;
  return resolve(ctx.callerCwd, expanded);
}

/** Runs one screen; marks the step done only when it completes. A failure offers a retry or pauses the setup. */
async function step(ctx: Ctx, id: Step): Promise<void> {
  if (OMP_ONLY.includes(id) && !usesOmp(ctx)) return markDone(ctx.root, id);
  for (;;) {
    try {
      await SCREENS[id](ctx);
      markDone(ctx.root, id);
      return;
    } catch (e) {
      p.log.error((e as Error).message);
      if (!answer(await p.confirm({ message: "Try this step again?" }))) {
        p.cancel(PAUSED);
        process.exit(0);
      }
    }
  }
}

async function tools(ctx: Ctx): Promise<void> {
  const found = Object.fromEntries(["git", "omp", "tern", "pass"].map((t) => [t, Bun.which(t) !== null]));
  p.log.info(Object.entries(found).map(([t, ok]) => `${ok ? "✓" : "·"} ${t}${ok ? "" : " (not found)"}`).join("\n"));
  if (!found.git) throw new Error("git is required; install it and run ./setup again");

  const ws = loadWorkspace(ctx.root);
  let agent = ws.tools?.agent;
  if (!agent) {
    const pick = answer(
      await p.select({
        message: "Which agent will you use?",
        options: [
          { value: "omp", label: "omp", hint: "recommended: full setup" },
          { value: "other", label: "Another agent", hint: "workspace only: no sign-in, drafting, MCP import or routing" },
        ],
        initialValue: "omp",
      }),
    );
    agent = pick === "omp" ? "omp" : answer(await p.text({ message: "Agent name", placeholder: "e.g. claude, codex" })).trim() || "other";
  }
  if (agent === "omp" && !found.omp) {
    if (!answer(await p.confirm({ message: "omp is not installed. Install it with: curl -fsSL https://omp.sh/install | sh ?" }))) {
      throw new Error("omp is required for the full setup");
    }
    if (ctx.run("sh", ["-c", "curl -fsSL https://omp.sh/install | sh"], { cwd: ctx.root, inherit: true }).status !== 0) throw new Error("omp install failed");
    // The installer puts omp in $PI_INSTALL_DIR or ~/.local/bin and only prints a PATH hint; make it visible to this run.
    process.env.PATH = `${process.env.PI_INSTALL_DIR ?? join(ctx.home, ".local", "bin")}:${process.env.PATH}`;
    if (!Bun.which("omp", { PATH: process.env.PATH })) {
      throw new Error("omp was installed but is not on PATH; add its folder (default ~/.local/bin) to PATH and run ./setup again");
    }
  }
  // Re-checked on every run, so installing pass later switches new MCP secrets to pass.
  const usePass = found.pass && passStore(ctx.home, process.env) !== undefined;
  if (!usePass) {
    p.log.warn(
      found.pass
        ? "pass is installed but its store is not set up: run pass init <gpg-id>. Until then, MCP secrets become environment variables."
        : "pass is not installed (brew install pass, or apt install pass, then pass init <gpg-id>). Until then, MCP secrets become environment variables.",
    );
  }
  saveWorkspace(ctx.root, { ...ws, tools: { ...ws.tools, terminal: found.tern ? "tern" : "plain", secrets: usePass ? "pass" : "env", agent } });
}

// No p.spinner() around blocking child processes: it never animates (the event loop is blocked) and its raw terminal
// mode turns Ctrl+C and git/ssh password prompts into plain characters. A log line before the call keeps both working.
async function signin(ctx: Ctx): Promise<void> {
  p.log.step("Checking that omp can reach a model…");
  if (smoke(ctx.run, ctx.root)) return p.log.success("omp answered");
  p.log.warn("No working provider yet. Sign in with omp (it shows its own provider list).");
  login(ctx.run, ctx.root);
  p.log.step("Checking again…");
  if (!smoke(ctx.run, ctx.root)) throw new Error("Sign-in did not work; run `omp login`, then ./setup again");
  p.log.success("omp answered");
}

async function org(ctx: Ctx): Promise<void> {
  const orgs = loadWorkspace(ctx.root).orgs;
  if (orgs.length) p.log.info(`Organisations: ${orgs.map((o) => o.id).join(", ")}`);
  const choice = answer(
    await p.select({
      message: "Organisation repo",
      options: [
        ...(orgs.length ? [{ value: "keep", label: "Keep" }] : []),
        { value: "add", label: orgs.length ? "Add another" : "Add one", hint: "a private repo made from core/templates/org" },
        ...(orgs.length ? [] : [{ value: "skip", label: "Skip", hint: "no projects until you add one" }]),
      ],
      initialValue: orgs.length ? "keep" : "add",
    }),
  );
  if (choice !== "add") return;
  const url = answer(await p.text({ message: "Git URL or local path of the org repo", validate: (v) => (v?.trim() ? undefined : "Required") }));
  p.log.success(`Added org ${orgAdd(ctx.root, pathOrUrl(url, ctx), ctx.core)}`);
}

async function projects(ctx: Ctx): Promise<void> {
  const ws = loadWorkspace(ctx.root);
  for (const o of ws.orgs) {
    const dir = join(ctx.root, "orgs", o.id, "projects");
    const offered = subdirs(dir).filter((id) => existsSync(join(dir, id, "project.yml")));
    const added = ws.projects.filter((x) => x.org === o.id).map((x) => x.id);
    if (added.length) p.log.info(`${o.id}: already added ${added.join(", ")}`);
    const rest = offered.filter((id) => !added.includes(id));
    if (!rest.length) continue;
    const picked = answer(
      await p.multiselect({
        message: `${o.id}: which projects do you work on?`,
        options: rest.map((id) => ({ value: id, label: String(field(yaml(join(dir, id, "project.yml")), "name") ?? id), hint: id })),
        required: false,
      }),
    );
    const said = { cloned: "cloned", present: "already there, left as is", created: "created empty (no url: put its files there)" };
    for (const id of picked) {
      p.log.step(`Setting up ${o.id}/${id}…`);
      const { repos } = projectAdd(ctx.root, `${o.id}/${id}`);
      p.log.success(`${o.id}/${id}: ${repos.map((r) => `${r.name} ${said[r.status]}`).join(", ")}`);
    }
  }
}

/** Role ids available to a project at core, org and project level, with the first description found. */
function roleOptions(ctx: Ctx, orgId: string, project: string): { value: string; label: string; hint?: string }[] {
  const dirs = [join(ctx.root, "orgs", orgId, "projects", project, "roles"), join(ctx.root, "orgs", orgId, "roles"), join(ctx.core, "workflow", "roles")];
  const ids = [...new Set(dirs.flatMap((d) => subdirs(d).filter((id) => existsSync(join(d, id, "role.yml")))))].sort();
  return ids.map((id) => {
    const desc = dirs.map((d) => field(yaml(join(d, id, "role.yml")), "description")).find((x) => typeof x === "string") as string | undefined;
    return { value: id, label: id, hint: desc };
  });
}

async function roles(ctx: Ctx): Promise<void> {
  for (const proj of loadWorkspace(ctx.root).projects) {
    const ref = `${proj.org}/${proj.id}`;
    const options = roleOptions(ctx, proj.org, proj.id).filter((o) => !proj.roles.includes(o.value));
    if (proj.roles.length) p.log.info(`${ref}: agents ${proj.roles.join(", ")}`);
    if (!options.length) continue;
    const picked = answer(await p.multiselect({ message: `${ref}: which agents do you want?`, options, required: false }));
    for (const r of picked) {
      try {
        roleAdd(ctx.root, ctx.core, ref, r);
        p.log.success(`${ref}: ${r} agent generated`);
      } catch (e) {
        p.log.warn(`${ref}: ${r} refused: ${(e as Error).message}`);
      }
    }
  }
}

async function context(ctx: Ctx): Promise<void> {
  const { done } = loadProgress(ctx.root);
  for (const proj of loadWorkspace(ctx.root).projects) {
    const ref = `${proj.org}/${proj.id}`;
    if (done.includes(`context:${ref}`)) continue;
    const file = join(ctx.root, "orgs", proj.org, "projects", proj.id, "context.md");
    const current = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    const lines = current ? current.split("\n").length : 0;
    // Org context is curated and reviewed in the org repo: keep it unless the engineer asks to replace it.
    if (current) p.note(current.split("\n").slice(0, 8).join("\n") + (lines > 8 ? `\n… (${lines} lines)` : ""), `Current context.md for ${ref}`);
    const ask = current ? `Draft a new context for ${ref} with omp?` : `Draft context for ${ref} with omp?`;
    if (!answer(await p.confirm({ message: `${ask} (it reads the repo; nothing is saved without your yes)`, initialValue: !current }))) {
      markDone(ctx.root, `context:${ref}`);
      continue;
    }
    p.log.step(`omp is reading ${proj.name} (up to 2 minutes)…`);
    const text = draft(ctx.run, ctx.core, repoDir(ctx.root, ref), CONTEXT_PROMPT);
    if (!text) {
      p.log.warn(`No draft for ${ref} (omp failed or timed out); try again later from this step`);
      continue;
    }
    p.note(text, `Draft context.md for ${ref}`);
    const save = current ? `Replace the current context.md (${lines} lines) with this draft?` : "Save it?";
    if (answer(await p.confirm({ message: save, initialValue: !current }))) {
      saveContext(ctx.root, ctx.core, ref, text);
      p.log.success(`Saved ${file}; agents refreshed. Commit it to the org repo through its review.`);
    }
    markDone(ctx.root, `context:${ref}`);
  }
}

async function mcp(ctx: Ctx): Promise<void> {
  const ws = loadWorkspace(ctx.root);
  const ompFile = join(ctx.home, ".omp", "agent", "mcp.json");
  const inOmp = Object.keys((field(existsSync(ompFile) ? JSON.parse(readFileSync(ompFile, "utf8")) : {}, "mcpServers") ?? {}) as object);
  const orgDirs = ws.orgs.map((o) => join(ctx.root, "orgs", o.id, "mcp"));
  const blocked = orgDirs.flatMap((d) => list(yaml(join(d, "block.yml")), "servers")).map((g) => new RegExp(`^${g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
  const allowed = orgDirs.flatMap((d) => list(yaml(join(d, "allow.yml")), "servers"));
  const found = scanServers(ctx.home);
  if (!found.length) return p.log.info("No MCP servers found in other agents' configs.");

  const status = (name: string) =>
    inOmp.includes(name) ? "already in omp" : blocked.some((re) => re.test(name)) ? "blocked by your org" : allowed.length && !allowed.includes(name) ? "not in your org's allow list" : "can be added";
  p.note(found.map((f) => `${f.name} · ${f.source.replace(ctx.home, "~")} · ${status(f.name)}`).join("\n"), "MCP servers in other agents");
  const candidates = found.filter((f, i) => found.findIndex((g) => g.name === f.name) === i && !inOmp.includes(f.name) && !blocked.some((re) => re.test(f.name)));
  if (!candidates.length) return;
  const picked = answer(
    await p.multiselect({
      message: "Add which ones to omp? (secrets are written as references, never copied)",
      options: candidates.map((f) => ({ value: f.name, label: f.name, hint: status(f.name) })),
      required: false,
    }),
  );
  if (!picked.length) return;
  const secrets = ws.tools?.secrets === "pass" ? "pass" : "env";
  const folder = `work/${ws.orgs[0]?.id ? `${ws.orgs[0].id}/` : ""}mcp`;
  const prefix = secrets === "pass" ? answer(await p.text({ message: "pass folder for these secrets (<folder>/<server>/<key>)", initialValue: folder })).trim() || folder : "";
  const later: string[] = [];
  for (const name of picked) {
    const f = candidates.find((c) => c.name === name);
    if (!f) continue;
    const imported = toOmp(name, f.entry, secrets, prefix);
    if ("skip" in imported) {
      p.log.warn(`${name}: skipped, it ${imported.skip}`);
      continue;
    }
    p.note(JSON.stringify(imported.entry, null, 2), `${name} for ${ompFile.replace(ctx.home, "~")}`);
    if (!answer(await p.confirm({ message: `Add ${name} to omp?` }))) continue;
    addToOmp(ompFile, name, imported.entry);
    p.log.success(`Added ${name}`);
    for (const s of imported.store) {
      if (secrets === "env") {
        later.push(`export ${s.ref}='<full value>'`);
        continue;
      }
      // pass prompts for the value itself (hidden, typed twice); the wizard never sees it.
      if (s.note) p.log.info(`${s.ref}: ${s.note}`);
      const now = answer(await p.confirm({ message: `Store ${s.ref} in pass now?`, initialValue: true }));
      if (now && ctx.run("pass", ["insert", s.ref], { cwd: ctx.root, inherit: true }).status === 0) p.log.success(`Stored ${s.ref}`);
      else later.push(`pass insert ${s.ref}${s.note ? `   # ${s.note}` : ""}`);
    }
  }
  if (later.length) p.note(later.join("\n"), secrets === "pass" ? "Still to store in pass" : "Set these environment variables (e.g. in your shell profile)");
}

async function routing(ctx: Ctx): Promise<void> {
  const reports = usage(ctx.run, ctx.root);
  if (reports?.length) {
    p.note(Object.entries(usageLines(reports)).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n"), "Usage per provider");
  } else p.log.info("omp reports no usage for your providers, so usage-based routing has nothing to go on.");

  const current = loadWorkspace(ctx.root).routing;
  const own = hasOwnRouting(ctx.run, ctx.root, join(ctx.home, ".omp", "agent"));
  const choice = answer(
    await p.select({
      message: "Model routing for project agents",
      options: current
        ? [
            { value: "keep", label: "Keep the current routing" },
            { value: "set", label: "Change it" },
            { value: "off", label: "Turn it off", hint: "agents use your own omp setup" },
          ]
        : [
            { value: "keep", label: own ? "Keep my setup (routing off)" : "Leave it off", hint: own ? "your omp already has fallback chains or a router" : "agents use your omp defaults" },
            { value: "set", label: "Set up usage-based routing", hint: own ? "two routers would both pick subagent models" : "switch provider before a limit is reached" },
          ],
      initialValue: current || own || !reports?.length ? "keep" : "set",
    }),
  );
  if (choice === "off") {
    routingOff(ctx.root, ctx.core);
    return p.log.success("Routing off; agents regenerated");
  }
  if (choice !== "set") return;

  const proposal = proposeRouting(reports ?? [], modelRoles(ctx.run, ctx.root), ["default", "task", "slow", "smol"], catalog(ctx.run, ctx.root));
  for (const role of ["default", "task", "slow", "smol"]) {
    const models = answer(
      await p.text({
        message: `Models for ${role}, in order (comma-separated; empty = not routed)`,
        initialValue: (current?.roles[role] ?? proposal[role] ?? []).join(", "),
      }),
    )
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length) routingSet(ctx.root, ctx.core, role, models);
    else routingClear(ctx.root, ctx.core, role);
  }
  if (!loadWorkspace(ctx.root).routing) return;
  const r = loadWorkspace(ctx.root).routing;
  if (answer(await p.confirm({ message: `Change the thresholds (skip a provider at ${r?.short}% of its short window, ${r?.week}% of its weekly)?`, initialValue: false }))) {
    const num = async (message: string, v: number) => Number(answer(await p.text({ message, initialValue: String(v) })));
    routingLimits(ctx.root, ctx.core, await num("Short-window limit (%)", r?.short ?? 95), await num("Weekly limit (%)", r?.week ?? 80));
  }
  p.log.success("Routing set; agents regenerated");
}

async function vault(ctx: Ctx): Promise<void> {
  const notes = loadWorkspace(ctx.root).notes;
  if (notes?.kind === "vault") p.log.info(`Vault: ${notes.path}`);
  const found = findVaults(ctx.home);
  const choice = answer(
    await p.select({
      message: "Notes vault",
      options: [
        ...(notes?.kind === "vault" ? [{ value: "keep", label: "Keep" }] : []),
        ...found.map((v) => ({ value: `use:${v}`, label: v.replace(ctx.home, "~") })),
        { value: "path", label: "Type a path" },
        { value: "new", label: "Create a new one", hint: "default folders: Decisions, People, Projects, …" },
        { value: "none", label: "No vault" },
      ],
      initialValue: notes?.kind === "vault" ? "keep" : found.length ? `use:${found[0]}` : "none",
    }),
  );
  if (choice === "keep") return;
  if (choice === "none") {
    const ws = loadWorkspace(ctx.root);
    return saveWorkspace(ctx.root, { ...ws, notes: { kind: "none" } });
  }
  const typed = choice.startsWith("use:") ? choice.slice(4) : answer(await p.text({ message: "Vault folder", validate: (v) => (v?.trim() ? undefined : "Required") }));
  const used = choice === "new" ? newVault(ctx.root, typed, ctx.core, ctx.callerCwd) : useVault(ctx.root, typed, ctx.callerCwd, ctx.core);
  p.note(Object.entries(used.folders ?? {}).map(([k, v]) => `${k} → ${v}`).join("\n") || "no matching folders", `Vault ${used.path}`);
}

async function verifyScreen(ctx: Ctx): Promise<void> {
  for (;;) {
    const checks = [...verify(ctx.root), ...passChecks(ctx.home, process.env)];
    p.note(checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.check}${c.ok || !c.detail ? "" : ` — ${c.detail}`}`).join("\n"), "Verify");
    if (checks.every((c) => c.ok)) return;
    const back = answer(
      await p.select({
        message: "Some checks failed. Go back to a step?",
        options: [{ value: "continue", label: "Continue anyway" }, ...STEPS.slice(2, 9).map((s) => ({ value: s, label: s }))],
        initialValue: "continue",
      }),
    );
    if (back === "continue") return;
    await step(ctx, back as Step);
  }
}

async function finish(ctx: Ctx): Promise<void> {
  const ws = loadWorkspace(ctx.root);
  const agents = ws.projects.flatMap((x) => x.roles.map((r) => `${x.org}/${x.id}/${r}`));
  const launch = (a: string) => String(field(field(yaml(join(ctx.root, "agents", a, "agent.yml")), "launch"), "omp") ?? "");
  p.note(
    [
      `Organisations: ${ws.orgs.map((o) => o.id).join(", ") || "none"}`,
      `Projects: ${ws.projects.map((x) => `${x.org}/${x.id}`).join(", ") || "none"}`,
      `Routing: ${ws.routing ? Object.keys(ws.routing.roles).join(", ") : "off"}`,
      `Vault: ${ws.notes?.kind === "vault" ? ws.notes.path : "none"}`,
    ].join("\n"),
    "Your workspace",
  );
  if (agents.length) {
    p.note(
      agents.map((a) => (usesOmp(ctx) ? `${a}\n  ${launch(a)}` : `${a}: open your agent in its cwd with role.md (agents/${a}/)`)).join("\n"),
      "Start a project agent",
    );
  }
}

const SCREENS: Record<Step, (ctx: Ctx) => Promise<void>> = {
  tools,
  signin,
  org,
  projects,
  roles,
  context,
  mcp,
  routing,
  vault,
  verify: verifyScreen,
  finish,
};

async function walk(ctx: Ctx, from: Step): Promise<void> {
  for (const s of STEPS.slice(STEPS.indexOf(from))) await step(ctx, s);
}

async function launchMain(ctx: Ctx): Promise<void> {
  if (!usesOmp(ctx)) return p.outro(`Open your agent in ${ctx.root}.`);
  if (answer(await p.confirm({ message: "Launch the Main session now? (omp in the workspace root)", initialValue: true }))) {
    p.outro("Starting omp");
    ctx.run("omp", [], { cwd: ctx.root, inherit: true });
  } else p.outro(`Start it later with: cd ${ctx.root} && omp`);
}

export async function runWizard(ctx: Ctx): Promise<void> {
  p.intro("agent-workspace setup");
  await step(ctx, "tools");
  await step(ctx, "signin");

  const started = loadProgress(ctx.root).done.some((d) => d !== "tools" && d !== "signin");
  if (!started) {
    await walk(ctx, "org");
    return launchMain(ctx);
  }
  for (;;) {
    const next = nextStep(ctx.root);
    const choice = answer(
      await p.select({
        message: next ? "Your setup was interrupted" : "Your workspace is set up",
        options: next
          ? [
              { value: "resume", label: `Resume at ${next}` },
              { value: "all", label: "Go through all steps again", hint: "keeps everything set up" },
              { value: "pick", label: "Pick one step" },
              { value: "exit", label: "Exit" },
            ]
          : [
              { value: "pick", label: "Change one step" },
              { value: "all", label: "Go through all steps again", hint: "keeps everything set up" },
              { value: "launch", label: "Launch the Main session" },
              { value: "exit", label: "Exit" },
            ],
        initialValue: next ? "resume" : "pick",
      }),
    );
    if (choice === "exit") return p.outro("Bye");
    if (choice === "launch") return launchMain(ctx);
    if (choice === "resume" && next) {
      await walk(ctx, next);
      return launchMain(ctx);
    }
    if (choice === "all") {
      restart(ctx.root);
      await walk(ctx, "org");
      return launchMain(ctx);
    }
    const picked = answer(await p.select({ message: "Which step?", options: STEPS.slice(2, 10).map((s) => ({ value: s, label: s })) }));
    await step(ctx, picked as Step);
  }
}
