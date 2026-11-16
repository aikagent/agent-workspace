import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVaults, loadWorkspace, newVault, orgAdd, projectAdd, roleAdd, routingClear, routingLimits, routingOff, routingSet, saveContext, useVault, verify } from "../src/workspace";

const CORE = join(import.meta.dir, "..", "..");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });

function repo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "aw-")));
  root = join(tmp, "ws");
  mkdirSync(root);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** An org repo built from the template, with one project "example" whose repo is a local git repo. */
function orgRepo(name: string, extra: Record<string, string> = {}): string {
  const src = join(tmp, `${name}-src`);
  cpSync(join(CORE, "templates", "org"), src, { recursive: true });
  const app = repo(join(tmp, `${name}-app`), { "README.md": name });
  writeFileSync(join(src, "org.yml"), `id: ${name}\nname: ${name}\n`);
  writeFileSync(
    join(src, "projects", "example", "project.yml"),
    `id: example\nname: example-project\nrepos:\n  - { name: app, url: "${app}", default: true }\ntest: { app: "true" }\n`,
  );
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(join(src, file, ".."), { recursive: true });
    writeFileSync(join(src, file), text);
  }
  return repo(src, {});
}

type Agent = { writes: boolean; cwd: string; launch: { omp: string } };
const readYaml = <T>(file: string) => Bun.YAML.parse(readFileSync(file, "utf8")) as T;

describe("orgAdd and projectAdd", () => {
  test("clones the org under its id and the project under projects/<org>/<name>/, and records both", () => {
    expect(orgAdd(root, orgRepo("acme"), CORE)).toBe("acme");
    expect(projectAdd(root, "acme/example")).toEqual({ dir: join(root, "projects", "acme", "example-project", "app"), repos: [{ name: "app", status: "cloned" }] });
    expect(existsSync(join(root, "projects", "acme", "example-project", "app", "README.md"))).toBe(true);
    const ws = loadWorkspace(root);
    expect(ws.orgs.map((o) => o.id)).toEqual(["acme"]);
    expect(ws.projects).toEqual([{ org: "acme", id: "example", name: "example-project", roles: [] }]);
  });

  test("two orgs with the same project id get separate checkouts", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    orgAdd(root, orgRepo("beta"), CORE);
    expect(projectAdd(root, "acme/example").dir).not.toBe(projectAdd(root, "beta/example").dir);
    expect(readFileSync(join(root, "projects", "beta", "example-project", "app", "README.md"), "utf8")).toBe("beta");
  });

  test("adding the same project twice changes nothing", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    expect(projectAdd(root, "acme/example").repos).toEqual([{ name: "app", status: "present" }]);
    expect(loadWorkspace(root).projects.length).toBe(1);
  });

  test("a repo without a url is a folder the engineer provides: created empty, never cloned", () => {
    orgAdd(root, orgRepo("acme", { "projects/stack/project.yml": "id: stack\nname: stack\nrepos:\n  - { name: compose }\n" }), CORE);
    const added = projectAdd(root, "acme/stack");
    expect(added).toEqual({ dir: join(root, "projects", "acme", "stack", "compose"), repos: [{ name: "compose", status: "created" }] });
    expect(existsSync(added.dir)).toBe(true);
    expect(existsSync(join(added.dir, ".git"))).toBe(false);
  });

  test("an empty url is refused rather than treated as a folder to provide", () => {
    orgAdd(root, orgRepo("acme", { "projects/bad/project.yml": 'id: bad\nname: bad\nrepos:\n  - { name: app, url: "" }\n' }), CORE);
    expect(() => projectAdd(root, "acme/bad")).toThrow("has an empty url");
  });

  test("an unknown project names the ones that exist", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    expect(() => projectAdd(root, "acme/nope")).toThrow('project "nope" not found in org acme; known: example');
  });

  test("names from the org repo cannot escape the workspace", () => {
    orgAdd(root, orgRepo("acme", { "projects/bad/project.yml": 'id: bad\nname: "../../escape"\nrepos:\n  - { name: app, url: "x" }\n' }), CORE);
    expect(() => projectAdd(root, "acme/bad")).toThrow('project name "../../escape" must be letters, digits, dots, dashes or underscores');
    expect(() => projectAdd(root, "../x")).toThrow('org "..": must be lowercase letters, digits and dashes');
  });
});

describe("roleAdd", () => {
  test("a read-only role denies every file-writing tool and carries its rules and context in role.md", () => {
    orgAdd(root, orgRepo("acme", { "projects/example/context.md": "Example context.\n" }), CORE);
    const repoDir = projectAdd(root, "acme/example").dir;
    roleAdd(root, CORE, "acme/example", "support");
    const dir = join(root, "agents", "acme", "example", "support");
    expect(readYaml<Agent>(join(dir, "agent.yml")).cwd).toBe(repoDir);
    expect(readYaml<{ tools: { approval: Record<string, string> } }>(join(dir, "overlay.yml")).tools.approval).toEqual({
      bash: "prompt",
      edit: "deny",
      write: "deny",
      ast_edit: "deny",
    });
    const md = readFileSync(join(dir, "role.md"), "utf8");
    expect(md).toContain("Example context.");
    expect(md).toContain("- no file changes");
    expect(execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  test("a project that makes dev read-only gets a read-only overlay", () => {
    orgAdd(root, orgRepo("acme", { "projects/example/roles/dev/role.yml": "id: dev\nextends: core:dev\nwrites: false\nreadOnlyPaths: [vendor]\n" }), CORE);
    projectAdd(root, "acme/example");
    roleAdd(root, CORE, "acme/example", "dev");
    const dir = join(root, "agents", "acme", "example", "dev");
    expect(readYaml<{ tools: { approval: Record<string, string> } }>(join(dir, "overlay.yml")).tools.approval.write).toBe("deny");
    const md = readFileSync(join(dir, "role.md"), "utf8");
    expect(md).toContain("- vendor");
    expect(md).not.toContain("<!-- project:dev -->");
  });

  test("every agent ignores the project repo's own MCP config (the org's MCP lists do not cover it)", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    for (const r of ["dev", "support"]) {
      roleAdd(root, CORE, "acme/example", r);
      const overlay = readYaml<{ mcp?: { enableProjectConfig?: boolean } }>(join(root, "agents", "acme", "example", r, "overlay.yml"));
      expect(overlay.mcp?.enableProjectConfig).toBe(false);
    }
  });

  test("a read-only role keeps MCP tools callable on omp (xd:// devices go through write)", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    roleAdd(root, CORE, "acme/example", "support");
    roleAdd(root, CORE, "acme/example", "dev");
    const overlay = (r: string) => readYaml<{ tools: { xdev?: boolean } }>(join(root, "agents", "acme", "example", r, "overlay.yml")).tools;
    expect(overlay("support").xdev).toBe(false);
    expect(overlay("dev").xdev).toBeUndefined();
  });

  test("role.md carries the org's rules and code hosts", () => {
    orgAdd(
      root,
      orgRepo("acme", {
        "org.yml": "id: acme\nname: Acme\nhosts:\n  - { match: git.acme.test, prTool: glab }\ntracker: jira\n",
        "rules/db.md": "Read-only database access through the wrappers.\n",
      }),
      CORE,
    );
    projectAdd(root, "acme/example");
    roleAdd(root, CORE, "acme/example", "dev");
    const md = readFileSync(join(root, "agents", "acme", "example", "dev", "role.md"), "utf8");
    expect(md).toContain("Read-only database access through the wrappers.");
    expect(md).toContain("git.acme.test → glab");
    expect(md).toContain("Tracker: jira");
  });

  test("the launch command uses absolute paths and the role's model tier", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    const repoDir = projectAdd(root, "acme/example").dir;
    roleAdd(root, CORE, "acme/example", "dev");
    const dir = join(root, "agents", "acme", "example", "dev");
    expect(readYaml<Agent>(join(dir, "agent.yml")).launch.omp).toBe(
      `omp --cwd '${repoDir}' --append-system-prompt '${join(dir, "role.md")}' --config '${join(dir, "overlay.yml")}' --model '@default'`,
    );
  });

  test("a tier without a model in workspace.yml uses the agent's matching model role", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    const launch = (r: string) => readYaml<Agent>(join(root, "agents", "acme", "example", r, "agent.yml")).launch.omp;
    roleAdd(root, CORE, "acme/example", "reviewer");
    roleAdd(root, CORE, "acme/example", "support");
    expect(launch("reviewer")).toEndWith("--model '@slow'");
    expect(launch("support")).toEndWith("--model '@task'");
    writeFileSync(join(root, "workspace.yml"), Bun.YAML.stringify({ ...loadWorkspace(root), models: { task: "acme-ai/small" } }));
    roleAdd(root, CORE, "acme/example", "support");
    expect(launch("support")).toEndWith("--model 'acme-ai/small'");
  });

  test("an unknown model tier without a model in workspace.yml is refused", () => {
    orgAdd(root, orgRepo("acme", { "roles/dev/role.yml": "id: dev\nextends: core:dev\nmodel: { tier: fast }\n" }), CORE);
    projectAdd(root, "acme/example");
    expect(() => roleAdd(root, CORE, "acme/example", "dev")).toThrow('model tier "fast" is not default, task or review');
    writeFileSync(join(root, "workspace.yml"), Bun.YAML.stringify({ ...loadWorkspace(root), models: { fast: "acme-ai/fast" } }));
    expect(roleAdd(root, CORE, "acme/example", "dev").id).toBe("dev");
  });

  test("an org role that loosens its core role is refused", () => {
    orgAdd(root, orgRepo("acme", { "roles/support/role.yml": "id: support\nextends: core:support\nwrites: true\n" }), CORE);
    projectAdd(root, "acme/example");
    expect(() => roleAdd(root, CORE, "acme/example", "support")).toThrow("cannot set writes: true");
  });

  test("a role may only use MCP servers the org allows and never a blocked one", () => {
    orgAdd(
      root,
      orgRepo("acme", {
        "mcp/allow.yml": "servers: [github, prod-db]\n",
        "mcp/block.yml": 'servers: ["*-db"]\n',
        "roles/support/role.yml": "id: support\nextends: core:support\nmcp: [prod-db]\n",
        "roles/dev/role.yml": "id: dev\nextends: core:dev\nmcp: [chat]\n",
      }),
      CORE,
    );
    projectAdd(root, "acme/example");
    expect(() => roleAdd(root, CORE, "acme/example", "support")).toThrow("prod-db is blocked by org acme");
    expect(() => roleAdd(root, CORE, "acme/example", "dev")).toThrow("chat is not in org acme's MCP allow list");
  });
});

describe("vault", () => {
  test("finds existing vaults and maps their folders", () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, "Documents", "Brain", ".obsidian"), { recursive: true });
    mkdirSync(join(home, "Documents", "Brain", "Decisions"));
    mkdirSync(join(home, "Documents", "Brain", "People"));
    expect(findVaults(home)).toEqual([join(home, "Documents", "Brain")]);
    const notes = useVault(root, join(home, "Documents", "Brain"), tmp, CORE);
    expect(notes.folders).toMatchObject({ decisions: "Decisions", people: "People" });
    expect(notes.folders.projects).toBeUndefined();
  });

  test("a new vault gets the default structure and nothing existing is overwritten", () => {
    const path = join(tmp, "Notes");
    mkdirSync(path);
    writeFileSync(join(path, "_index.md"), "mine");
    newVault(root, "Notes", CORE, tmp);
    expect(readFileSync(join(path, "_index.md"), "utf8")).toBe("mine");
    expect(existsSync(join(path, "Decisions", "README.md"))).toBe(true);
  });

  test("a vault inside the workspace or the tool folder is refused", () => {
    expect(() => newVault(root, join(root, "notes"), CORE, tmp)).toThrow("is inside the tool folder");
    expect(() => newVault(root, join(CORE, "..", "Notes"), CORE, tmp)).toThrow("is inside the tool folder");
  });
});

describe("verify", () => {
  test("reports a registered project whose folder is missing", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    rmSync(join(root, "projects", "acme"), { recursive: true });
    expect(verify(root).filter((c) => !c.ok).map((c) => c.check)).toContain("project acme/example present");
  });

  test("an empty workspace says that nothing is set up yet", () => {
    const check = verify(root).find((c) => c.check === "at least one project set up");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toBe("nothing configured yet; run ./setup");
    orgAdd(root, orgRepo("acme"), CORE);
    expect(verify(root).find((c) => c.check === "at least one project set up")?.detail).toContain("./setup project add acme/<project>");
  });

  test("flags org deny words found in the tool repo's tracked files", () => {
    repo(root, { "README.md": "built for Initech" });
    orgAdd(root, orgRepo("acme", { "denywords.txt": "# words\ninitech\n" }), CORE);
    const check = verify(root).find((c) => c.check === "no org acme words in the tool repo");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("README.md");
  });

  test("a tracked file deleted locally does not break the deny-word check", () => {
    repo(root, { "README.md": "fine", "gone.md": "fine" });
    rmSync(join(root, "gone.md"));
    orgAdd(root, orgRepo("acme", { "denywords.txt": "initech\n" }), CORE);
    expect(verify(root).find((c) => c.check === "no org acme words in the tool repo")?.ok).toBe(true);
  });
});

describe("saveContext", () => {
  test("writes the org project's context.md and refreshes that project's agents", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    roleAdd(root, CORE, "acme/example", "dev");
    const file = saveContext(root, CORE, "acme/example", "# Example\nBuild with make.");
    expect(file).toBe(join(root, "orgs", "acme", "projects", "example", "context.md"));
    expect(readFileSync(file, "utf8")).toBe("# Example\nBuild with make.\n");
    expect(readFileSync(join(root, "agents", "acme", "example", "dev", "role.md"), "utf8")).toContain("Build with make.");
  });
});

describe("routing", () => {
  type Overlay = { retry?: { usageAwareFallback: boolean; usageReservePct: number; fallbackChains: Record<string, string[]> } };
  const agentDir = () => join(root, "agents", "acme", "example", "support");

  test("turning routing on regenerates existing agents with the router and limit fallback", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    roleAdd(root, CORE, "acme/example", "support");
    routingSet(root, CORE, "task", ["a/one", "b/two"]);
    const overlay = readYaml<Overlay>(join(agentDir(), "overlay.yml"));
    expect(overlay.retry).toEqual({
      usageAwareFallback: true,
      usageReservePolicy: "auto",
      usageReservePct: 5,
      fallbackChains: { task: ["a/one", "b/two"] },
    } as Overlay["retry"]);
    const launch = readYaml<Agent>(join(agentDir(), "agent.yml")).launch.omp;
    expect(launch).toStartWith(`AGENT_WORKSPACE_ROUTING='${join(root, "agents", "routing.json")}' omp `);
    expect(launch).toContain(`-e '${join(CORE, "adapters", "agent", "omp", "usage-router", "index.ts")}'`);
    expect(readYaml<unknown>(join(root, "agents", "routing.json"))).toEqual({ short: 95, week: 80, roles: { task: ["a/one", "b/two"] } });

    routingLimits(root, CORE, 90, 70);
    expect(readYaml<Overlay>(join(agentDir(), "overlay.yml")).retry?.usageReservePct).toBe(10);
    expect(readYaml<{ week: number }>(join(root, "agents", "routing.json")).week).toBe(70);
  });

  test("turning routing off restores the plain agent", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    roleAdd(root, CORE, "acme/example", "support");
    const plain = readFileSync(join(agentDir(), "agent.yml"), "utf8");
    routingSet(root, CORE, "task", ["a/one"]);
    routingOff(root, CORE);
    expect(readFileSync(join(agentDir(), "agent.yml"), "utf8")).toBe(plain);
    expect(readYaml<Overlay>(join(agentDir(), "overlay.yml")).retry).toBeUndefined();
    expect(loadWorkspace(root).routing).toBeUndefined();
  });

  test("clearing one role keeps the others; clearing the last one turns routing off", () => {
    routingSet(root, CORE, "task", ["a/one"]);
    routingSet(root, CORE, "smol", ["a/small"]);
    routingClear(root, CORE, "task");
    expect(loadWorkspace(root).routing?.roles).toEqual({ smol: ["a/small"] });
    routingClear(root, CORE, "smol");
    expect(loadWorkspace(root).routing).toBeUndefined();
    routingClear(root, CORE, "smol");
    expect(loadWorkspace(root).routing).toBeUndefined();
  });

  test("models must be provider/model and limits whole percentages", () => {
    expect(() => routingSet(root, CORE, "task", ["sonnet"])).toThrow('model "sonnet" must be <provider>/<model>');
    expect(() => routingSet(root, CORE, "task", [])).toThrow("at least one model");
    expect(() => routingSet(root, CORE, "Task", ["a/one"])).toThrow('role "Task"');
    expect(() => routingLimits(root, CORE, 0, 80)).toThrow("between 1 and 100");
  });
});
