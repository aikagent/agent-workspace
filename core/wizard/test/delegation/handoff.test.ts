import { expect, test } from "bun:test";
import { buildHandoff } from "../../../adapters/agent/omp/delegation/src/handoff";
import { formatResult, noTernWindowText } from "../../../adapters/agent/omp/delegation/src/format";
import type { DelegationRequest, DelegationResponse } from "../../../adapters/agent/omp/delegation/src/protocol";

const base: Omit<DelegationRequest, "handoff"> = {
  protocol: "omp-delegation/v1",
  delegationId: "dlg_01JCBF0NYV6QK8X4KFX9ABCDEF",
  mode: "execute",
  sync: true,
  project: "acme/shop",
  role: "dev",
  agentKey: "acme/shop/dev",
  writes: true,
  repo: ".",
  repoPath: "/w/projects/acme/shop",
  cwd: "/w/projects/acme/shop",
  git: true,
  command: "omp",
  objective: "Run the nightly batch",
  criteria: [{ id: "C1", check: "every order has a note" }],
  mustNot: ["no edits under repositories/"],
  context: { workCompleted: ["fetched 12 orders"] },
  readOnlyPaths: ["repositories"],
  repository: { branch: "dev", dirty: false, changedFiles: [], fingerprint: "f" },
  parent: { ternPane: 1 },
  createdAt: "2026-11-12T00:00:00Z",
};

test("the handoff carries the rules a project agent must follow", () => {
  const text = buildHandoff(base);
  expect(text).toContain("[omp-delegation/v1 dlg_01JCBF0NYV6QK8X4KFX9ABCDEF] agent=acme/shop/dev mode=execute");
  expect(text).toContain("skip any session-start protocol");
  expect(text).toContain("C1: every order has a note");
  expect(text).toContain("- no edits under repositories/");
  expect(text).toContain("read-only paths: repositories");
  expect(text).toContain("edit only inside the target checkout");
  expect(text).toContain("call request_decision with delegation_id dlg_01JCBF0NYV6QK8X4KFX9ABCDEF");
  expect(text).toContain("calling return_delegation with delegation_id dlg_01JCBF0NYV6QK8X4KFX9ABCDEF");
});

test("an ask handoff forbids edits", () => {
  expect(buildHandoff({ ...base, mode: "ask" })).toContain("Answer only: do not modify any file.");
});

test("a read-only role changes no files and runs only named commands", () => {
  const text = buildHandoff({ ...base, writes: false, role: "ops", agentKey: "acme/shop/ops" });
  expect(text).toContain("you change no files yourself; run only the commands this task names, each behind the approval prompt");
  expect(text).not.toContain("edit only inside the target checkout");
});

test("formatResult shows claims per criterion and warnings", () => {
  const resp: DelegationResponse = {
    protocol: "omp-delegation/v1",
    delegationId: base.delegationId,
    project: "acme/shop/dev",
    status: "completed",
    result: {
      delegationId: base.delegationId, status: "completed", summary: "done",
      criteria: [{ id: "C1", status: "met", evidence: "12 notes" }],
      mustNot: [{ rule: "no edits under repositories/", respected: true, evidence: "diff clean" }],
      findings: [], changes: [], tests: { commands: [] }, risks: [],
    },
  };
  const out = formatResult({ ...base, handoff: "h" }, resp, ["w1"]);
  expect(out).toContain("C1 every order has a note → claimed met: 12 notes");
  expect(out).toContain("- w1");
});

test("no_tern_window names both causes", () => {
  const text = noTernWindowText({ ...base, handoff: "h" });
  expect(text).toContain("No Tern window holds this Main pane (1)");
  expect(text).toContain("or the omp-delegation Tern plugin is not loaded (./setup verify)");
});
