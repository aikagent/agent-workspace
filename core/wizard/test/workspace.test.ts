import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVaults, loadWorkspace, newVault, orgAdd, projectAdd, roleAdd, useVault, verify } from "../src/workspace";

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
    expect(projectAdd(root, "acme/example")).toBe(join(root, "projects", "acme", "example-project", "app"));
    expect(existsSync(join(root, "projects", "acme", "example-project", "app", "README.md"))).toBe(true);
    const ws = loadWorkspace(root);
    expect(ws.orgs.map((o) => o.id)).toEqual(["acme"]);
    expect(ws.projects).toEqual([{ org: "acme", id: "example", name: "example-project", roles: [] }]);
  });

  test("two orgs with the same project id get separate checkouts", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    orgAdd(root, orgRepo("beta"), CORE);
    expect(projectAdd(root, "acme/example")).not.toBe(projectAdd(root, "beta/example"));
    expect(readFileSync(join(root, "projects", "beta", "example-project", "app", "README.md"), "utf8")).toBe("beta");
  });

  test("adding the same project twice changes nothing", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    projectAdd(root, "acme/example");
    projectAdd(root, "acme/example");
    expect(loadWorkspace(root).projects.length).toBe(1);
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
    const repoDir = projectAdd(root, "acme/example");
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
    expect(readFileSync(join(dir, "role.md"), "utf8")).toContain("- vendor");
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

  test("the launch command uses absolute paths", () => {
    orgAdd(root, orgRepo("acme"), CORE);
    const repoDir = projectAdd(root, "acme/example");
    roleAdd(root, CORE, "acme/example", "dev");
    const dir = join(root, "agents", "acme", "example", "dev");
    expect(readYaml<Agent>(join(dir, "agent.yml")).launch.omp).toBe(
      `omp --cwd '${repoDir}' --append-system-prompt '${join(dir, "role.md")}' --config '${join(dir, "overlay.yml")}'`,
    );
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
    expect(verify(root).filter((c) => !c.ok).map((c) => c.check)).toContain("project acme/example cloned");
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
