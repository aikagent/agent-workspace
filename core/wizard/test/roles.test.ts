import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChain, mergeChain, type RoleLayer } from "../src/roles";

const core: RoleLayer = {
  origin: "core:support",
  role: { id: "support", writes: false, tools: { deny: ["edit", "write"], prompt: ["bash"] }, mustNot: ["no commits"], model: { tier: "task" } },
  instructions: "Investigate. Report evidence.",
};

describe("mergeChain", () => {
  test("lists are unioned, scalars take the most specific value, instructions run core to project", () => {
    const org: RoleLayer = {
      origin: "org:support",
      role: { id: "support", extends: "core:support", readOnlyPaths: ["vendor"], model: { tier: "slow" } },
      instructions: "Org notes.",
    };
    const project: RoleLayer = {
      origin: "project:support",
      role: { id: "support", extends: "org:support", mustNot: ["no PRs"] },
      instructions: "Project notes.",
    };
    const r = mergeChain([core, org, project]);
    expect(r.tools.deny).toEqual(["edit", "write"]);
    expect(r.tools.prompt).toEqual(["bash"]);
    expect(r.mustNot).toEqual(["no commits", "no PRs"]);
    expect(r.readOnlyPaths).toEqual(["vendor"]);
    expect(r.model).toEqual({ tier: "slow" });
    expect(r.instructions.map((i) => i.origin)).toEqual(["core:support", "org:support", "project:support"]);
  });

  test("a lower level cannot make a read-only role write", () => {
    const org: RoleLayer = { origin: "org:support", role: { id: "support", extends: "core:support", writes: true }, instructions: "" };
    expect(() => mergeChain([core, org])).toThrow("org:support: cannot set writes: true on a read-only parent");
  });

  test("a lower level cannot allow tools", () => {
    const org: RoleLayer = { origin: "org:support", role: { id: "support", extends: "core:support", tools: { allow: ["edit"] } }, instructions: "" };
    expect(() => mergeChain([core, org])).toThrow("org:support: tools.allow can only be set in core");
  });

  test("a lower level can only narrow mcp and skills", () => {
    const base: RoleLayer = { origin: "core:dev", role: { id: "dev", writes: true, mcp: ["github", "tracker"] }, instructions: "" };
    const narrow: RoleLayer = { origin: "org:dev", role: { id: "dev", extends: "core:dev", mcp: ["github"] }, instructions: "" };
    expect(mergeChain([base, narrow]).mcp).toEqual(["github"]);
    const widen: RoleLayer = { origin: "org:dev", role: { id: "dev", extends: "core:dev", mcp: ["github", "database"] }, instructions: "" };
    expect(() => mergeChain([base, widen])).toThrow("org:dev: mcp adds database, which the parent does not allow");
  });

  test("a writing role can become read-only", () => {
    const base: RoleLayer = { origin: "core:dev", role: { id: "dev", writes: true }, instructions: "" };
    const ro: RoleLayer = { origin: "project:dev", role: { id: "dev", extends: "core:dev", writes: false }, instructions: "" };
    expect(mergeChain([base, ro]).writes).toBe(false);
  });
});

describe("loadChain", () => {
  let tmp: string;
  const dirs = () => ({ core: join(tmp, "core"), org: join(tmp, "org"), project: join(tmp, "project") });
  const role = (level: string, id: string, yml: string) => {
    mkdirSync(join(tmp, level, id), { recursive: true });
    writeFileSync(join(tmp, level, id, "role.yml"), yml);
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "aw-roles-")));
    role("core", "support", "id: support\nwrites: false\ntools: { deny: [edit] }\n");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("follows project → org → core", () => {
    role("org", "support", "id: support\nextends: core:support\nmustNot: [no prod]\n");
    role("project", "support", "id: support\nextends: org:support\n");
    expect(loadChain(dirs(), "support").map((l) => l.origin)).toEqual(["core:support", "org:support", "project:support"]);
  });


  test("a project role cannot drop the org role of its id by extending another role", () => {
    role("core", "dev", "id: dev\nwrites: true\n");
    role("org", "support", "id: support\nextends: core:support\nmustNot: [no prod]\n");
    role("project", "support", "id: support\nextends: core:dev\n");
    expect(() => loadChain(dirs(), "support")).toThrow("project:support: must build on org:support");
  });
  test("a project role cannot skip an org role of the same id", () => {
    role("org", "support", "id: support\nextends: core:support\nmustNot: [no prod]\n");
    role("project", "support", "id: support\nextends: core:support\n");
    expect(() => loadChain(dirs(), "support")).toThrow("project:support: extends core:support but org:support exists; extend org:support");
  });

  test("a missing parent is named", () => {
    role("org", "triage", "id: triage\nextends: core:nope\n");
    expect(() => loadChain(dirs(), "triage")).toThrow('org:triage: extends "core:nope", which does not exist');
  });

  test("an org role must extend a core role", () => {
    role("org", "a", "id: a\nextends: org:b\n");
    expect(() => loadChain(dirs(), "a")).toThrow("must point to a more general level");
  });

  test("fields with the wrong type are refused", () => {
    role("org", "support", "id: support\nextends: core:support\ntools: { deny: bash }\n");
    expect(() => loadChain(dirs(), "support")).toThrow("tools.deny must be a list of strings");
    role("org", "support", "id: support\nextends: core:support\nwrites: no\n");
    expect(() => loadChain(dirs(), "support")).toThrow("writes must be true or false");
    role("org", "support", "");
    expect(() => loadChain(dirs(), "support")).toThrow("role.yml is empty or not a mapping");
  });
});
