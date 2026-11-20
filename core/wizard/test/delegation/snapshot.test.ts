import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot } from "../../../adapters/agent/omp/delegation/src/snapshot";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

function repo(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "dlg-snap-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "a");
  return dir;
}

describe("git snapshot", () => {
  test("clean checkout", () => {
    const s = snapshot(repo(), true);
    expect(s).toMatchObject({ branch: "main", dirty: false, changedFiles: [] });
  });

  test("an edit marks it dirty and changes the fingerprint, a second edit too", () => {
    const dir = repo();
    const clean = snapshot(dir, true);
    writeFileSync(join(dir, "a.txt"), "b");
    const once = snapshot(dir, true);
    expect(once.dirty).toBe(true);
    expect(once.changedFiles).toEqual(["a.txt"]);
    expect(once.fingerprint).not.toBe(clean.fingerprint);
    writeFileSync(join(dir, "a.txt"), "c");
    utimesSync(join(dir, "a.txt"), new Date(), new Date(Date.now() + 5000));
    expect(snapshot(dir, true).fingerprint).not.toBe(once.fingerprint);
  });

  test("a commit changes the fingerprint of a clean checkout", () => {
    const dir = repo();
    const before = snapshot(dir, true);
    git(dir, "commit", "-q", "--allow-empty", "-m", "b");
    expect(snapshot(dir, true).fingerprint).not.toBe(before.fingerprint);
  });
});

describe("non-git snapshot", () => {
  test("touching a file changes the fingerprint", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "dlg-snap-"));
    writeFileSync(join(dir, "docker-compose.yml"), "x");
    const before = snapshot(dir, false);
    expect(snapshot(dir, false).fingerprint).toBe(before.fingerprint);
    utimesSync(join(dir, "docker-compose.yml"), new Date(), new Date(Date.now() + 5000));
    expect(snapshot(dir, false).fingerprint).not.toBe(before.fingerprint);
  });
});

describe("snapshot size", () => {
  test("the request carries at most 50 changed files, the fingerprint covers all of them", () => {
    const dir = repo();
    for (let i = 0; i < 60; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), "x");
    const before = snapshot(dir, true);
    expect(before.dirty).toBe(true);
    expect(before.changedFiles.length).toBe(50);
    writeFileSync(join(dir, "f59.txt"), "changed and longer");
    expect(snapshot(dir, true).fingerprint).not.toBe(before.fingerprint);
  });
});
