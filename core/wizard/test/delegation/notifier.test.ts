import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDelegationId } from "../../../adapters/agent/omp/delegation/src/ids";
import { Mailbox } from "../../../adapters/agent/omp/delegation/src/mailbox";
import { createNotifier, recentForPane } from "../../../adapters/agent/omp/delegation/src/notifier";
import type { DelegationRequest } from "../../../adapters/agent/omp/delegation/src/protocol";

let mb: Mailbox;
let reads: string[];
let said: string[];
const waiting = new Set<string>();
const skip = new Set<string>();

const request = (id: string, pane: number, sync: boolean): DelegationRequest => ({
  protocol: "omp-delegation/v1", delegationId: id, mode: "execute", sync, project: "acme/shop", role: "dev", agentKey: "acme/shop/dev",
  writes: true, repo: ".", repoPath: "/x", cwd: "/x", git: true, command: "omp", objective: "o", criteria: [{ id: "C1", check: "ok" }],
  mustNot: [], context: {}, readOnlyPaths: [], repository: { dirty: false, changedFiles: [], fingerprint: "f" },
  parent: { ternPane: pane }, handoff: "h", createdAt: "2026-11-12T00:00:00Z",
});
const done = (id: string) => mb.writeResponse({ protocol: "omp-delegation/v1", delegationId: id, project: "acme/shop/dev", status: "completed" });
let n = 0;
const make = (pane: number, sync: boolean) => {
  const id = newDelegationId(1_700_000_000_000 + n++);
  mb.writeRequest(request(id, pane, sync));
  return id;
};

beforeEach(() => {
  mb = new Mailbox(mkdtempSync(join(realpathSync(tmpdir()), "dlg-nt-")));
  waiting.clear();
  skip.clear();
  reads = [];
  said = [];
  const original = mb.readRequest.bind(mb);
  mb.readRequest = (id: string) => (reads.push(id), original(id));
});

const notifier = (pane = 1) => createNotifier(mb, pane, { waiting, skip }, (m) => said.push(m));

describe("notifier", () => {
  test("announces a decision once and the finish once, then stops reading the request", () => {
    const id = make(1, false);
    mb.appendEvent(id, "project", { kind: "decision_request", decisionId: "d1", decisionKind: "clarification", question: "which env?" });
    const nt = notifier();
    nt.tick();
    nt.tick();
    expect(said.length).toBe(1);
    expect(said[0]).toContain("which env?");
    done(id);
    nt.tick();
    expect(said.length).toBe(2);
    reads.length = 0;
    nt.tick();
    expect(reads).toEqual([]);
  });

  test("another pane's request is read once, then skipped", () => {
    make(2, false);
    const nt = notifier();
    nt.tick();
    nt.tick();
    expect(reads.length).toBe(1);
    expect(said).toEqual([]);
  });

  test("requests already finished at start are never announced or read", () => {
    const id = make(1, false);
    done(id);
    notifier().tick();
    expect(said).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("a sync request this process is waiting on is left alone; once it stops waiting it surfaces", () => {
    const id = make(1, true);
    mb.appendEvent(id, "project", { kind: "decision_request", decisionId: "d1", decisionKind: "go_ahead", question: "deploy?" });
    waiting.add(id);
    const nt = notifier();
    nt.tick();
    expect(said).toEqual([]);
    waiting.delete(id);
    nt.tick();
    expect(said.length).toBe(1);
  });
});

describe("recentForPane", () => {
  test("returns the newest requests of this pane, reading only until it has enough", () => {
    const mine = [make(1, true), make(2, true), make(1, true), make(1, true)];
    expect(recentForPane(mb, 1, 2)).toEqual([mine[2], mine[3]]);
    expect(reads.length).toBeLessThanOrEqual(3);
  });
});
