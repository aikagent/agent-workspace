import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyEntry, defineProject, rebuildVenvs, repointWorktrees, rewritePaths, runImport, scanSource } from "../src/importer";
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
    const r = rewritePaths([map.app], src, map, tmp);
    expect(readFileSync(join(map.app, ".env"), "utf8")).toBe(`KB=${map.kb}/x\nOTHER=${src}/kb-old/y\n`);
    expect(r).toEqual({ rewritten: [join(map.app, ".env")], tracked: [join(map.app, "Makefile")] });
    expect(readFileSync(join(src, "app", ".env"), "utf8")).toContain(`${src}/kb/x`);
  });

  test("home-relative forms (~ and $HOME) are rewritten too", () => {
    put(join(src, "app", "run.sh"), "cat ~/Code/kb/a $HOME/Code/kb/b\n");
    mkdirSync(join(src, "kb"));
    const map = { app: join(ws, "p", "app"), kb: join(ws, "p", "kb") };
    for (const [top, dest] of Object.entries(map)) copyEntry(join(src, top), dest);
    rewritePaths([map.app], src, map, tmp);
    expect(readFileSync(join(map.app, "run.sh"), "utf8")).toBe("cat ~/ws/p/kb/a $HOME/ws/p/kb/b\n");
  });
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
