import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, resolveTarget } from "../../../adapters/agent/omp/delegation/src/agents";

let root: string;
let shop: string;
let other: string;

function agent(org: string, project: string, role: string, cwd: string, extra = "") {
  const dir = join(root, "agents", org, project, role);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yml"), `id: ${role}\ncwd: ${cwd}\n${extra}launch:\n  omp: "omp --cwd '${cwd}'"\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "dlg-agents-"));
  shop = join(root, "projects", "acme", "shop");
  other = join(root, "projects", "zed", "shop");
  mkdirSync(join(shop, "repositories", "api"), { recursive: true });
  mkdirSync(join(shop, "plain"), { recursive: true });
  mkdirSync(other, { recursive: true });
  execFileSync("git", ["-C", shop, "init", "-q"], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  agent("acme", "shop", "dev", shop, "writes: true\nreadOnlyPaths:\n  - repositories\nmustNot:\n  - no commits\n");
  agent("acme", "shop", "support", shop);
  agent("acme", "tools", "dev", other, "writes: true\n");
  agent("zed", "shop", "dev", other, "writes: true\n");
});

const resolveIt = (project: string, role?: string, mode: "execute" | "ask" = "execute", repo?: string, main = tmpdir()) =>
  resolveTarget(loadAgents(root), project, role, mode, repo, main);

describe("loadAgents", () => {
  test("reads every agent.yml", () => {
    const a = loadAgents(root).find((x) => x.org === "acme" && x.project === "shop" && x.role === "dev");
    expect(a).toMatchObject({ writes: true, readOnlyPaths: ["repositories"], mustNot: ["no commits"], cwd: shop });
    expect(a?.launch).toContain("omp --cwd");
  });

  test("a malformed agent.yml is named and the others still load", () => {
    const dir = join(root, "agents", "acme", "shop", "ops");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yml"), "cwd: [unclosed");
    const errors: string[] = [];
    expect(loadAgents(root, errors).length).toBe(4);
    expect(errors[0]).toContain(join(dir, "agent.yml"));
  });
});

describe("resolveTarget errors and git", () => {
  test("a malformed agent.yml is named in the unknown-project and missing-role errors", () => {
    const errors = ["/w/agents/acme/shop/ops/agent.yml: needs cwd and launch.omp"];
    const agents = loadAgents(root);
    expect(() => resolveTarget(agents, "nope", undefined, "execute", undefined, tmpdir(), errors)).toThrow(errors[0]);
    expect(() => resolveTarget(agents, "acme/shop", "ops", "execute", undefined, tmpdir(), errors)).toThrow(errors[0]);
  });

  test("a checkout inside someone else's repository is not git for this agent", () => {
    execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(resolveIt("acme/tools").git).toBe(false);
    expect(resolveIt("acme/shop", "dev").git).toBe(true);
  });
});

describe("resolveTarget", () => {
  test("org/project and a unique bare id both resolve", () => {
    expect(resolveIt("acme/shop").key).toBe("acme/shop/dev");
    expect(resolveIt("tools").key).toBe("acme/tools/dev");
  });

  test("a bare id in two orgs is ambiguous", () => {
    expect(() => resolveIt("shop")).toThrow('project "shop" is in several orgs: acme, zed; use org/project');
  });

  test("unknown project lists the known ones", () => {
    expect(() => resolveIt("x")).toThrow('unknown project "x"; known: acme/shop, acme/tools, zed/shop');
  });

  test("role defaults: execute is dev, ask is support; a missing role lists the roles", () => {
    expect(resolveIt("acme/shop", undefined, "ask").role).toBe("support");
    expect(() => resolveIt("acme/tools", undefined, "ask")).toThrow('acme/tools has no role "support"; roles: dev');
    expect(resolveIt("acme/shop", "support", "execute").writes).toBe(false);
  });

  test("repo defaults to the cwd and must exist inside it", () => {
    expect(resolveIt("acme/shop", "support").repoPath).toBe(shop);
    expect(resolveIt("acme/shop", "support", "ask", "plain").repoPath).toBe(join(shop, "plain"));
    expect(() => resolveIt("acme/shop", "support", "ask", "nope")).toThrow("does not exist");
    expect(() => resolveIt("acme/shop", "support", "ask", "..")).toThrow("escapes");
  });

  test("a symlink out of the checkout escapes", () => {
    symlinkSync(root, join(shop, "plain", "out"));
    expect(() => resolveIt("acme/shop", "support", "ask", "plain/out")).toThrow("escapes");
  });

  test("a writing role may not target a read-only path", () => {
    expect(() => resolveIt("acme/shop", "dev", "execute", "repositories/api")).toThrow("repositories/api is read-only for acme/shop/dev");
    expect(resolveIt("acme/shop", "support", "ask", "repositories/api").repoPath).toBe(join(shop, "repositories", "api"));
  });

  test("Main inside the target cwd is refused", () => {
    expect(() => resolveIt("acme/shop", "dev", "execute", undefined, join(shop, "plain"))).toThrow("Main already works in acme/shop");
  });

  test("git is false outside a repository", () => {
    expect(resolveIt("acme/shop", "dev").git).toBe(true);
    expect(resolveIt("acme/tools").git).toBe(false);
  });
});
