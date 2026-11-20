import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyEntry, defineProject, rebuildVenvs, repointSymlinks, repointWorktrees, rewritePaths, runImport, scanSource } from "../src/importer";
import { loadWorkspace } from "../src/workspace";
import type { Runner } from "../src/omp";

let tmp: string;
let src: string;
let ws: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "aw-import-")));
  src = join(tmp, "Code");
  ws = join(tmp, "ws");
  mkdirSync(src);
  mkdirSync(ws);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const put = (path: string, text = "x") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
function repo(dir: string, files: Record<string, string> = { "README.md": "r" }) {
  for (const [f, t] of Object.entries(files)) put(join(dir, f), t);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

describe("scanSource", () => {
  test("proposes projects and data, matching org projects by repo folder name or git remote", () => {
    repo(join(src, "app"));
    repo(join(src, "billing-svc"));
    git(join(src, "billing-svc"), "remote", "add", "origin", "git@example.test:acme/billing.git");
    repo(join(src, "tool"));
    put(join(src, "notes", "CLAUDE.md"));
    put(join(src, "backups", "dump.sql"));
    put(join(src, "todo.md"));
    put(join(src, ".DS_Store"));
    const org = [
      { id: "web", repos: [{ name: "app" }] },
      { id: "billing", repos: [{ name: "billing", url: "git@example.test:acme/billing.git" }] },
    ];
    expect(scanSource(src, org).map((e) => [e.name, e.kind, e.projectId ?? null])).toEqual([
      ["app", "project", "web"],
      ["backups", "data", null],
      ["billing-svc", "project", "billing"],
      ["notes", "project", null],
      ["todo.md", "data", null],
      ["tool", "project", null],
    ]);
  });
});

describe("copyEntry", () => {
  test("copies once; the copy is independent and an existing destination is left as is", () => {
    put(join(src, "app", "a.txt"), "original");
    const dest = join(ws, "projects", "acme", "web", "app");
    expect(copyEntry(join(src, "app"), dest)).toBe("copied");
    writeFileSync(join(dest, "a.txt"), "changed in the copy");
    expect(readFileSync(join(src, "app", "a.txt"), "utf8")).toBe("original");
    expect(copyEntry(join(src, "app"), dest)).toBe("present");
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("changed in the copy");
  });
});

describe("repointWorktrees", () => {
  test("worktrees of a copied repo resolve to the copy, inside and outside the repo folder", () => {
    repo(join(src, "app"));
    git(join(src, "app"), "worktree", "add", "-q", join(src, "app", "wt-in"), "-b", "in");
    git(join(src, "app"), "worktree", "add", "-q", join(src, "app-wt"), "-b", "out");
    expect(scanSource(src, []).find((e) => e.name === "app-wt")).toMatchObject({ kind: "project", worktreeOf: "app" });
    const map = { app: join(ws, "p", "app"), "app-wt": join(ws, "p", "app-wt") };
    for (const [top, dest] of Object.entries(map)) copyEntry(join(src, top), dest);
    const r = repointWorktrees(Object.values(map), src, map);
    expect(r.outside).toEqual([]);
    for (const wt of [join(map.app, "wt-in"), map["app-wt"]]) {
      expect(git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(join(map.app, ".git"));
    }
    expect(git(join(src, "app-wt"), "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(join(src, "app", ".git"));
  });
});

describe("rewritePaths", () => {
  test("untracked local files point at the copies; tracked files are listed and unchanged; the source is unchanged", () => {
    repo(join(src, "app"), { "README.md": "r", ".gitignore": ".env\n", "Makefile": `KB=${src}/kb/x\n` });
    put(join(src, "app", ".env"), `KB=${src}/kb/x\nOTHER=${src}/kb-old/y\n`);
    mkdirSync(join(src, "kb"));
    const map = { app: join(ws, "p", "app"), kb: join(ws, "p", "kb") };
    for (const [top, dest] of Object.entries(map)) copyEntry(join(src, top), dest);
    const r = rewritePaths([map.app], [src], map, tmp);
    expect(readFileSync(join(map.app, ".env"), "utf8")).toBe(`KB=${map.kb}/x\nOTHER=${src}/kb-old/y\n`);
    // .env still names a source folder that was not imported: listed so the copy is not silently tied to it
    expect(r).toEqual({ rewritten: [join(map.app, ".env")], tracked: [join(map.app, "Makefile")], stillNaming: [join(map.app, ".env")] });
    expect(readFileSync(join(src, "app", ".env"), "utf8")).toContain(`${src}/kb/x`);
  });

  test("home-relative forms (~ and $HOME) are rewritten too", () => {
    put(join(src, "app", "run.sh"), "cat ~/Code/kb/a $HOME/Code/kb/b\n");
    mkdirSync(join(src, "kb"));
    const map = { app: join(ws, "p", "app"), kb: join(ws, "p", "kb") };
    for (const [top, dest] of Object.entries(map)) copyEntry(join(src, top), dest);
    rewritePaths([map.app], [src], map, tmp);
    expect(readFileSync(join(map.app, "run.sh"), "utf8")).toBe("cat ~/ws/p/kb/a $HOME/ws/p/kb/b\n");
  });
});

  test("paths written through a symlinked source folder and requirements files are rewritten", () => {
    symlinkSync(src, join(tmp, "Link"));
    put(join(src, "app", ".env"), "KB=~/Link/kb/a\n");
    put(join(src, "app", "requirements.txt"), `-e ${src}/lib\n`);
    mkdirSync(join(src, "kb"));
    mkdirSync(join(src, "lib"));
    const map = { app: join(ws, "p", "app"), kb: join(ws, "p", "kb"), lib: join(ws, "p", "lib") };
    for (const [top, dest] of Object.entries(map)) copyEntry(join(src, top), dest);
    rewritePaths([map.app], [join(tmp, "Link"), src], map, tmp);
    expect(readFileSync(join(map.app, ".env"), "utf8")).toBe("KB=~/ws/p/kb/a\n");
    expect(readFileSync(join(map.app, "requirements.txt"), "utf8")).toBe(`-e ${map.lib}\n`);
  });

describe("rebuildVenvs", () => {
  test("a copied venv tied to the source is kept as .copied and rebuilt with uv in the copy", () => {
    const proj = join(ws, "p", "app");
    put(join(proj, "uv.lock"));
    put(join(proj, ".venv", "pyvenv.cfg"), "version_info = 3.12.4\n");
    put(join(proj, ".venv", "bin", "activate"), `VIRTUAL_ENV='${src}/app/.venv'\n`);
    const calls: string[] = [];
    const run: Runner = (cmd, args, opts) => (calls.push(`${opts.cwd}: ${cmd} ${args.join(" ")}`), { status: 0, stdout: "" });
    expect(rebuildVenvs([proj], src, run)).toEqual([{ venv: join(proj, ".venv"), result: "rebuilt" }]);
    expect(existsSync(join(proj, ".venv.copied", "pyvenv.cfg"))).toBe(true);
    expect(calls).toEqual([`${proj}: uv sync --frozen -q`]);
    expect(rebuildVenvs([proj], src, run)).toEqual([]);
  });

  test("a venv whose manifest still names the source is not rebuilt (it would build inside the source)", () => {
    const proj = join(ws, "p", "app");
    put(join(proj, "requirements.txt"), `-e ${src}/lib\n`);
    put(join(proj, ".venv", "pyvenv.cfg"), "version = 3.12.4\n");
    put(join(proj, ".venv", "bin", "activate"), `VIRTUAL_ENV='${src}/app/.venv'\n`);
    const calls: string[] = [];
    const run: Runner = (cmd, args) => (calls.push(`${cmd} ${args.join(" ")}`), { status: 0, stdout: "" });
    expect(rebuildVenvs([proj], src, run)).toEqual([{ venv: join(proj, ".venv"), result: "names-source" }]);
    expect(calls).toEqual([]);
    expect(existsSync(join(proj, ".venv.copied"))).toBe(true);
  });
});

describe("defineProject", () => {
  test("adds an org project for a folder you provide, with a safe id and folder name, never overwriting one", () => {
    const org = join(ws, "orgs", "acme");
    mkdirSync(join(org, "projects", "web"), { recursive: true });
    expect(defineProject(org, "Web")).toEqual({ id: "web-2", repo: "Web" });
    expect(defineProject(org, "My Notes!")).toEqual({ id: "my-notes", repo: "my-notes" });
    const yml = Bun.YAML.parse(readFileSync(join(org, "projects", "web-2", "project.yml"), "utf8")) as { id: string; name: string; repos: unknown[] };
    expect(yml).toEqual({ id: "web-2", name: "web-2", repos: [{ name: "Web", default: true }] });
    expect(existsSync(join(org, "projects", "web-2", "context.md"))).toBe(true);
  });
});

describe("runImport", () => {
  test("copies chosen projects into the org layout and the rest into data/, then registers the projects", () => {
    const org = join(ws, "orgs", "acme");
    put(join(org, "org.yml"), "id: acme\nname: Acme\n");
    put(join(org, "projects", "web", "project.yml"), 'id: web\nname: web-app\nrepos:\n  - { name: site, url: "git@example.test:acme/site.git", default: true }\n');
    repo(join(src, "my-site"));
    git(join(src, "my-site"), "remote", "add", "origin", "git@example.test:acme/site.git");
    git(join(src, "my-site"), "worktree", "add", "-q", join(src, "my-site-fix"), "-b", "fix");
    put(join(src, "notes", "CLAUDE.md"));
    put(join(src, "backups", "dump.sql"));
    put(join(src, "loose.md"));
    const entries = scanSource(src, [{ id: "web", repos: [{ name: "site", url: "git@example.test:acme/site.git" }] }]).filter((e) => e.name !== "loose.md");
    const done: string[] = [];
    const report = runImport({ root: ws, org: "acme", src, home: tmp, run: () => ({ status: 0, stdout: "" }) }, entries, (n) => done.push(n));

    expect(existsSync(join(ws, "projects", "acme", "web-app", "site", "README.md"))).toBe(true);
    expect(git(join(ws, "projects", "acme", "web-app", "my-site-fix"), "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
      join(ws, "projects", "acme", "web-app", "site", ".git"),
    );
    expect(existsSync(join(ws, "projects", "acme", "notes", "notes", "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(ws, "data", "backups", "dump.sql"))).toBe(true);
    expect(existsSync(join(ws, "data", "loose.md"))).toBe(false);
    expect(loadWorkspace(ws).projects.map((p) => p.id).sort()).toEqual(["notes", "web"]);
    expect(report.newProjects).toEqual([join(org, "projects", "notes")]);
    expect(done.sort()).toEqual(["backups", "my-site", "my-site-fix", "notes"]);

    // a second run copies nothing again
    expect(runImport({ root: ws, org: "acme", src, home: tmp, run: () => ({ status: 0, stdout: "" }) }, entries, () => {}).copied).toEqual([]);
  });
});

describe("import safety", () => {
  const ctx = () => ({ root: ws, org: "acme", src, home: tmp, run: (() => ({ status: 0, stdout: "" })) as Runner });
  const orgWith = (projects: Record<string, string>) => {
    const org = join(ws, "orgs", "acme");
    put(join(org, "org.yml"), "id: acme\nname: Acme\n");
    for (const [id, yml] of Object.entries(projects)) put(join(org, "projects", id, "project.yml"), yml);
    return org;
  };

  test("a retry after a failed copy fixes the copies made before the failure", () => {
    orgWith({});
    repo(join(src, "app"));
    git(join(src, "app"), "worktree", "add", "-q", join(src, "app-wt"), "-b", "feature");
    put(join(src, "zz", "locked", "f"));
    chmodSync(join(src, "zz", "locked"), 0o000);
    try {
      const entries = scanSource(src, []).map((e) => ({ ...e, kind: e.name === "zz" ? ("data" as const) : e.kind }));
      expect(() => runImport(ctx(), entries, () => {})).toThrow("could not copy");
      expect(existsSync(join(ws, "data", "zz"))).toBe(false);
      runImport(ctx(), entries.filter((e) => e.name !== "zz"), () => {});
    } finally {
      chmodSync(join(src, "zz", "locked"), 0o755);
    }
    expect(git(join(ws, "projects", "acme", "app", "app-wt"), "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(join(ws, "projects", "acme", "app", "app", ".git"));
  });

  test("a worktree imported without its repo is disconnected, so it cannot write to the original", () => {
    orgWith({});
    repo(join(src, "app"));
    git(join(src, "app"), "worktree", "add", "-q", join(src, "app-wt"), "-b", "feature");
    const before = git(join(src, "app"), "rev-parse", "feature");
    const report = runImport(ctx(), scanSource(src, []).filter((e) => e.name === "app-wt"), () => {});
    const copy = join(ws, "projects", "acme", "app-wt", "app-wt");
    expect(existsSync(join(copy, ".git"))).toBe(false);
    expect(existsSync(join(copy, ".git.copied"))).toBe(true);
    expect(report.worktrees.disconnected).toEqual([copy]);
    expect(git(join(src, "app"), "rev-parse", "feature")).toBe(before);
  });

  test("symlinks: a linked entry is copied as a folder; links inside a copy are re-pointed or reported", () => {
    put(join(tmp, "elsewhere", "notes", "CLAUDE.md"), "original");
    symlinkSync(join(tmp, "elsewhere", "notes"), join(src, "notes"));
    copyEntry(join(src, "notes"), join(ws, "p", "notes"));
    expect(lstatSync(join(ws, "p", "notes")).isSymbolicLink()).toBe(false);
    writeFileSync(join(ws, "p", "notes", "CLAUDE.md"), "edited copy");
    expect(readFileSync(join(tmp, "elsewhere", "notes", "CLAUDE.md"), "utf8")).toBe("original");

    put(join(src, "shared", "AGENTS.md"));
    put(join(src, "solo", "AGENTS.md"));
    put(join(src, "app", "x"));
    symlinkSync(join(src, "shared", "AGENTS.md"), join(src, "app", "AGENTS.md"));
    symlinkSync(join(src, "solo", "AGENTS.md"), join(src, "app", "SOLO.md"));
    const map = { app: join(ws, "p", "app"), shared: join(ws, "p", "shared") };
    for (const [top, dest] of Object.entries(map)) copyEntry(join(src, top), dest);
    expect(repointSymlinks([map.app], src, map)).toEqual({ fixed: 1, outside: [join(map.app, "SOLO.md")] });
    expect(readlinkSync(join(map.app, "AGENTS.md"))).toBe(join(map.shared, "AGENTS.md"));
  });

  test("a checkout matched by git remote lands in that repo's folder; two entries for one folder are refused", () => {
    orgWith({ platform: 'id: platform\nname: platform\nrepos:\n  - { name: api, url: "git@x.test:o/api.git", default: true }\n  - { name: web, url: "git@x.test:o/web.git" }\n' });
    repo(join(src, "my-web"));
    git(join(src, "my-web"), "remote", "add", "origin", "git@x.test:o/web.git");
    repo(join(src, "web-old"));
    git(join(src, "web-old"), "remote", "add", "origin", "git@x.test:o/web.git");
    const org = [{ id: "platform", repos: [{ name: "api", url: "git@x.test:o/api.git" }, { name: "web", url: "git@x.test:o/web.git" }] }];
    const entries = scanSource(src, org);
    expect(entries.find((e) => e.name === "my-web")).toMatchObject({ projectId: "platform", repo: "web" });
    expect(() => runImport(ctx(), entries, () => {})).toThrow("my-web and web-old would both go to");
    const report = runImport(ctx(), entries.filter((e) => e.name === "my-web"), () => {});
    expect(existsSync(join(ws, "projects", "acme", "platform", "web", ".git"))).toBe(true);
    // the other repo of the project could not be cloned (no such host): reported, the import still completes
    expect(report.failed.map((f) => f.ref)).toEqual(["acme/platform"]);
  });

  test("folders whose names need a safe form are matched on later runs instead of added again", () => {
    orgWith({});
    put(join(src, "My Notes", "CLAUDE.md"));
    put(join(src, "_scratch", "AGENTS.md"));
    for (let i = 0; i < 2; i++) runImport(ctx(), scanSource(src, []), () => {});
    expect(loadWorkspace(ws).projects.map((p) => p.id).sort()).toEqual(["my-notes", "scratch"]);
  });
});
