import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { runtimeDir } from "../../../adapters/agent/omp/delegation/src/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDelegationId } from "../../../adapters/agent/omp/delegation/src/ids";
import { Mailbox } from "../../../adapters/agent/omp/delegation/src/mailbox";
import type { DelegationRequest } from "../../../adapters/agent/omp/delegation/src/protocol";

let mb: Mailbox;
let root: string;

const request = (id: string, objective = "fix it"): DelegationRequest => ({
  protocol: "omp-delegation/v1",
  delegationId: id,
  mode: "execute",
  sync: true,
  project: "acme/shop",
  role: "dev",
  agentKey: "acme/shop/dev",
  writes: true,
  repo: ".",
  repoPath: "/x",
  cwd: "/x",
  git: true,
  command: "omp",
  objective,
  criteria: [{ id: "C1", check: "ok" }],
  mustNot: [],
  context: {},
  readOnlyPaths: [],
  repository: { dirty: false, changedFiles: [], fingerprint: "f" },
  parent: { ternPane: 1 },
  handoff: "h",
  createdAt: "2026-11-12T00:00:00Z",
});

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "dlg-mb-"));
  mb = new Mailbox(root);
});

describe("requests", () => {
  test("a request is invisible until its marker exists", () => {
    const id = newDelegationId();
    mkdirSync(join(root, "requests"), { recursive: true });
    writeFileSync(join(root, "requests", `${id}.json`), JSON.stringify(request(id)));
    expect(mb.readRequest(id)).toBeUndefined();
    expect(mb.listRequests()).toEqual([]);
  });

  test("round trip", () => {
    const id = newDelegationId();
    mb.writeRequest(request(id));
    expect(mb.readRequest(id)?.objective).toBe("fix it");
    expect(mb.listRequests()).toEqual([id]);
  });

  test("an oversized request fails and stays invisible", () => {
    const id = newDelegationId();
    expect(() => mb.writeRequest(request(id, "x".repeat(70 * 1024)))).toThrow("larger than 65536 bytes");
    expect(mb.listRequests()).toEqual([]);
  });

  test("cancel marks the request", () => {
    const id = newDelegationId();
    mb.writeRequest(request(id));
    mb.cancel(id);
    expect(mb.isCancelled(id)).toBe(true);
  });

  test("every method refuses an invalid id", () => {
    expect(() => mb.readRequest("dlg_../../x")).toThrow("invalid delegation id");
    expect(() => mb.cancel("../x")).toThrow("invalid delegation id");
    expect(() => mb.readResponse("x")).toThrow("invalid delegation id");
  });
});

describe("events", () => {
  test("new events are read once, in order, and unmarked ones are skipped", () => {
    const id = newDelegationId();
    mb.appendEvent(id, "plugin", { kind: "status", status: "queued" });
    mb.appendEvent(id, "project", { kind: "approval_pending", tool: "bash", reason: "git push" });
    writeFileSync(join(root, "events", id, "9999999999999-x-half.json"), "{}");
    const seen = new Set<string>();
    expect(mb.readEvents(id, seen).map((e) => e.kind)).toEqual(["status", "approval_pending"]);
    expect(mb.readEvents(id, seen)).toEqual([]);
  });

  test("pendingDecisions lists questions without an answer", () => {
    const id = newDelegationId();
    mb.appendEvent(id, "project", { kind: "decision_request", decisionId: "d1", decisionKind: "go_ahead", question: "migrate?" });
    mb.appendEvent(id, "project", { kind: "decision_request", decisionId: "d2", decisionKind: "clarification", question: "which env?" });
    mb.appendEvent(id, "main", { kind: "decision_answer", decisionId: "d1", answer: "yes" });
    expect(mb.pendingDecisions(id).map((d) => d.decisionId)).toEqual(["d2"]);
  });
});

describe("responses and state", () => {
  test("a response is invisible until done, and cannot be written twice", () => {
    const id = newDelegationId();
    expect(mb.readResponse(id)).toBeUndefined();
    mb.writeResponse({ protocol: "omp-delegation/v1", delegationId: id, project: "acme/shop/dev", status: "stalled" });
    expect(mb.readResponse(id)?.status).toBe("stalled");
    expect(() => mb.writeResponse({ protocol: "omp-delegation/v1", delegationId: id, project: "acme/shop/dev", status: "completed" })).toThrow("already has a response");
  });

  test("activeFor reads the plugin's active file and refuses odd project names", () => {
    const id = newDelegationId();
    mkdirSync(join(root, "active"), { recursive: true });
    writeFileSync(join(root, "active", "acme.shop.dev.json"), JSON.stringify({ delegationId: id }));
    expect(mb.activeFor("acme/shop/dev")).toBe(id);
    expect(mb.activeFor("acme/shop/ops")).toBeUndefined();
    expect(() => mb.activeFor("../shop")).toThrow("invalid agent key");
  });
});

describe("transcripts", () => {
  test("a transcript is invisible until its .ready marker exists", () => {
    const id = newDelegationId();
    mkdirSync(join(root, "responses"), { recursive: true });
    writeFileSync(join(root, "responses", `${id}.transcript.json`), "[]");
    expect(mb.readTranscript(id)).toBeUndefined();
    writeFileSync(join(root, "responses", `${id}.transcript.ready`), "");
    expect(mb.readTranscript(id)).toEqual([]);
  });
});

describe("permissions", () => {
  test("the runtime root and every parent it creates are private (0700)", () => {
    const fresh = new Mailbox(join(root, "ws", "delegation"));
    fresh.ensure();
    for (const d of ["ws", "ws/delegation", "ws/delegation/requests"]) {
      expect(statSync(join(root, d)).mode & 0o777).toBe(0o700);
    }
  });
});

describe("runtime directories under HOME", () => {
  const modeOf = (p: string) => statSync(p).mode & 0o777;
  const six = ["requests", "claims", "events", "responses", "status", "active"];

  test("ensure creates ~/.agent-workspace, delegation/, its six subdirs and sessions/ privately", () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), "dlg-home-"));
    new Mailbox(runtimeDir({ HOME: home })).ensure();
    const base = join(home, ".agent-workspace");
    for (const d of [base, join(base, "delegation"), join(base, "sessions"), ...six.map((s) => join(base, "delegation", s))]) {
      expect(modeOf(d)).toBe(0o700);
    }
  });

  test("existing looser dirs owned by the user are tightened to 0700", () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), "dlg-home-"));
    const base = join(home, ".agent-workspace");
    const dirs = [base, join(base, "delegation"), join(base, "sessions"), join(base, "delegation", "requests")];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
      chmodSync(d, 0o755);
    }
    new Mailbox(runtimeDir({ HOME: home })).ensure();
    for (const d of dirs) expect(modeOf(d)).toBe(0o700);
  });
});
