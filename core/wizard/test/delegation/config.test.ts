import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegationOn, flagOn, isWorkspaceRoot, runtimeDir, workspaceRoot } from "../../../adapters/agent/omp/delegation/src/config";

const tmp = () => mkdtempSync(join(realpathSync(tmpdir()), "dlg-cfg-"));

test("delegation is on only with `delegation: on` in workspace.yml", () => {
  const root = tmp();
  expect(delegationOn(root)).toBe(false);
  writeFileSync(join(root, "workspace.yml"), "orgs: []\n");
  expect(delegationOn(root)).toBe(false);
  writeFileSync(join(root, "workspace.yml"), "delegation: on\norgs: []\n");
  expect(delegationOn(root)).toBe(true);
  writeFileSync(join(root, "workspace.yml"), "delegation: off\n");
  expect(delegationOn(root)).toBe(false);
  writeFileSync(join(root, "workspace.yml"), "delegation: [broken\n");
  expect(delegationOn(root)).toBe(false);
});

test("Main side needs omp started in the root itself", () => {
  const root = tmp();
  mkdirSync(join(root, "sub"));
  expect(isWorkspaceRoot(root, root)).toBe(true);
  expect(isWorkspaceRoot(root, join(root, "sub"))).toBe(false);
});

test("root and runtime dir come from the module path unless overridden", () => {
  expect(workspaceRoot({}, "/w/core/adapters/agent/omp/delegation/src")).toBe("/w");
  expect(workspaceRoot({ AGENT_WORKSPACE_ROOT: "/x" })).toBe("/x");
  expect(runtimeDir({ AGENT_WORKSPACE_DELEGATION_DIR: "/r" })).toBe("/r");
  expect(runtimeDir({})).toMatch(/\.agent-workspace\/delegation$/);
});

test("flagOn accepts only the string on or true", () => {
  expect([flagOn("on"), flagOn(true), flagOn("off"), flagOn(false), flagOn(undefined), flagOn("yes")]).toEqual([true, true, false, false, false, false]);
});
