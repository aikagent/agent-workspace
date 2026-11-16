import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProgress, markDone, nextStep, restart } from "../src/progress";
import { loadWorkspace, saveWorkspace } from "../src/workspace";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aw-progress-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("progress", () => {
  test("a fresh workspace starts at the organisation step", () => {
    expect(loadProgress(root)).toEqual({ done: [], finished: false });
    expect(nextStep(root)).toBe("org");
  });

  test("an interrupted run resumes at the first step not done", () => {
    for (const s of ["tools", "signin", "org", "projects"]) markDone(root, s);
    markDone(root, "projects");
    expect(loadProgress(root).done).toEqual(["tools", "signin", "org", "projects"]);
    expect(nextStep(root)).toBe("roles");
  });

  test("context items are recorded per project and do not complete the step", () => {
    for (const s of ["org", "projects", "roles"]) markDone(root, s);
    markDone(root, "context:acme/app");
    expect(loadProgress(root).done).toContain("context:acme/app");
    expect(nextStep(root)).toBe("context");
  });

  test("reaching finish marks the setup finished; going through again keeps the workspace", () => {
    saveWorkspace(root, { ...loadWorkspace(root), orgs: [{ id: "acme", url: "u" }] });
    for (const s of ["org", "projects", "roles", "context", "mcp", "routing", "vault", "verify", "finish"]) markDone(root, s);
    expect(loadProgress(root).finished).toBe(true);
    expect(nextStep(root)).toBeUndefined();
    restart(root);
    expect(loadProgress(root)).toEqual({ done: [], finished: false });
    expect(loadWorkspace(root).orgs).toEqual([{ id: "acme", url: "u" }]);
  });

  test("workspace commands keep the progress", () => {
    markDone(root, "org");
    const ws = loadWorkspace(root);
    saveWorkspace(root, { ...ws, projects: [{ org: "acme", id: "app", name: "app", roles: [] }] });
    expect(loadProgress(root).done).toEqual(["org"]);
  });
});
