import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegationChecks, delegationOff, delegationOn, ternLinkCommand } from "../src/delegation";
import { STEPS } from "../src/progress";
import { delegationEnabled, loadWorkspace, orgAdd, projectAdd, roleAdd, saveWorkspace } from "../src/workspace";

const CORE = join(import.meta.dir, "..", "..");
const EXT = `-e '${join(CORE, "adapters", "agent", "omp", "delegation", "index.ts")}'`;
let tmp: string;
let root: string;

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "ignore" });
const launch = () => readFileSync(join(root, "agents", "acme", "shop", "support", "agent.yml"), "utf8");
const listing = (plugins: unknown) => () => ({ status: 0, stdout: JSON.stringify(plugins) });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "aw-")));
  root = join(tmp, "ws");
  mkdirSync(root);
  process.env.AGENT_WORKSPACE_DELEGATION_DIR = join(tmp, "ignored");
  const org = join(tmp, "org");
  mkdirSync(join(org, "projects", "shop"), { recursive: true });
  writeFileSync(join(org, "org.yml"), "id: acme\n");
  writeFileSync(join(org, "projects", "shop", "project.yml"), "id: shop\nname: Shop\nrepos:\n  - { name: app }\n");
  git(org, "init", "-q", "-b", "main");
  git(org, "add", "-A");
  git(org, "commit", "-qm", "i");
  orgAdd(root, org, CORE);
  projectAdd(root, "acme/shop");
  roleAdd(root, CORE, "acme/shop", "support");
});
afterEach(() => {
  delete process.env.AGENT_WORKSPACE_DELEGATION_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("delegation", () => {
  test("on adds the extension to every agent, off removes it", () => {
    expect(launch()).not.toContain("delegation");
    delegationOn(root, CORE);
    expect(launch()).toContain(EXT);
    delegationOff(root, CORE);
    expect(launch()).not.toContain("delegation/index.ts");
  });

  test("roles added later get the extension", () => {
    delegationOn(root, CORE);
    roleAdd(root, CORE, "acme/shop", "support");
    expect(launch()).toContain(EXT);
  });

  test("the step sits between routing and vault", () => {
    expect(STEPS.indexOf("delegation")).toBe(STEPS.indexOf("routing") + 1);
    expect(STEPS.indexOf("vault")).toBe(STEPS.indexOf("delegation") + 1);
  });

  test("checks: off is one ok line", () => {
    expect(delegationChecks(root, CORE, tmp, listing([]))).toEqual([{ check: "delegation off", ok: true }]);
  });

  test("checks: on reports loader, plugin, launches and runtime dir", () => {
    delegationOn(root, CORE);
    const failing = delegationChecks(root, CORE, tmp, listing([]));
    expect(failing.filter((c) => !c.ok).map((c) => c.check)).toEqual(expect.arrayContaining(["tern plugin omp-delegation loaded"]));
    const ok = delegationChecks(root, CORE, tmp, listing([{ id: "omp-delegation", loaded: true }]));
    expect(ok.find((c) => c.check.startsWith("tern plugin"))?.ok).toBe(true);
    expect(ok.filter((c) => c.check.includes("launches")).every((c) => c.ok)).toBe(true);
    expect(ok.find((c) => c.check.includes("runtime"))?.ok).toBe(true);
    expect(delegationChecks(root, CORE, tmp, () => ({ status: 0, stdout: "garbage" })).find((c) => c.check.startsWith("tern plugin"))?.ok).toBe(false);
  });

  test("only on or true count as on", () => {
    const ws = loadWorkspace(root);
    expect([undefined, "on", "off", true, false].map((d) => delegationEnabled({ ...ws, delegation: d as never }))).toEqual([false, true, false, true, false]);
  });

  test("delegation: off in workspace.yml counts as off", () => {
    saveWorkspace(root, { ...loadWorkspace(root), delegation: "off" as never });
    roleAdd(root, CORE, "acme/shop", "support");
    expect(launch()).not.toContain("delegation/index.ts");
    expect(delegationChecks(root, CORE, tmp, listing([]))).toEqual([{ check: "delegation off", ok: true }]);
  });

  test("a plugin listed in problems is not loaded", () => {
    delegationOn(root, CORE);
    const bad = delegationChecks(root, CORE, tmp, listing({ plugins: [{ id: "omp-delegation" }], problems: [{ plugin: "omp-delegation", error: "boom" }] }));
    expect(bad.find((c) => c.check.startsWith("tern plugin"))?.ok).toBe(false);
    const fine = delegationChecks(root, CORE, tmp, listing({ plugins: [{ id: "omp-delegation" }], problems: [{ plugin: "other" }] }));
    expect(fine.find((c) => c.check.startsWith("tern plugin"))?.ok).toBe(true);
  });

  test("runtime dir is ~/.agent-workspace/delegation, private, and ignores the env override", () => {
    delegationOn(root, CORE);
    const c = delegationChecks(root, CORE, tmp, listing([])).find((x) => x.check.includes("runtime"));
    const dir = join(tmp, ".agent-workspace", "delegation");
    expect(c).toMatchObject({ ok: true, detail: dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => statSync(join(tmp, "ignored"))).toThrow();
  });

  test("the displayed link command quotes the plugin path", () => {
    expect(ternLinkCommand("/tmp/my core")).toBe("tern plugin link '/tmp/my core/adapters/terminal/tern/delegation'");
  });
});
