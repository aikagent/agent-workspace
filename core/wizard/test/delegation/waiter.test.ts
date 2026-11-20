import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDelegationId } from "../../../adapters/agent/omp/delegation/src/ids";
import { Mailbox } from "../../../adapters/agent/omp/delegation/src/mailbox";
import { waitForAnswer, waitForDelegation, waitForTranscript } from "../../../adapters/agent/omp/delegation/src/waiter";

let root: string;
let mb: Mailbox;
let id: string;

const claim = () => {
  mkdirSync(join(root, "claims"), { recursive: true });
  writeFileSync(join(root, "claims", `${id}.json`), "{}");
};

/** A sleep that runs `script(tick)` instead of waiting, so tests drive the plugin's side. */
function scripted(script: (tick: number) => void) {
  let tick = 0;
  return async () => {
    tick += 1;
    script(tick);
  };
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "dlg-wait-"));
  mb = new Mailbox(root);
  id = newDelegationId();
});

describe("waitForDelegation", () => {
  test("returns the response once it is done", async () => {
    const progress: string[] = [];
    const out = await waitForDelegation(mb, id, {
      onProgress: (t) => progress.push(t),
      onDecision: async () => undefined,
      sleep: scripted((tick) => {
        if (tick === 1) {
          claim();
          mb.appendEvent(id, "plugin", { kind: "status", status: "dispatched" });
        }
        if (tick === 3) mb.writeResponse({ protocol: "omp-delegation/v1", delegationId: id, project: "acme/shop/dev", status: "stalled" });
      }),
    });
    expect(out).toEqual({ kind: "response", response: expect.objectContaining({ status: "stalled" }) });
    expect(progress).toContain("dispatched");
  });

  test("reports no_tern_window when nobody claims the request in time", async () => {
    let clock = 0;
    const out = await waitForDelegation(mb, id, {
      onProgress: () => {},
      onDecision: async () => undefined,
      claimTimeoutMs: 10_000,
      now: () => clock,
      sleep: async () => {
        clock += 5_000;
      },
    });
    expect(out).toEqual({ kind: "no_tern_window" });
  });

  test("asks the user once per decision and writes his answer", async () => {
    const asked: string[] = [];
    await waitForDelegation(mb, id, {
      onProgress: () => {},
      onDecision: async (ev) => {
        asked.push(ev.question);
        return "yes";
      },
      sleep: scripted((tick) => {
        if (tick === 1) {
          claim();
          mb.appendEvent(id, "project", { kind: "decision_request", decisionId: "d1", decisionKind: "go_ahead", question: "run migration?" });
        }
        if (tick === 4) mb.writeResponse({ protocol: "omp-delegation/v1", delegationId: id, project: "acme/shop/dev", status: "stalled" });
      }),
    });
    expect(asked).toEqual(["run migration?"]);
    expect(mb.pendingDecisions(id)).toEqual([]);
  });

  test("leaves a decision pending when there is no UI to ask", async () => {
    await waitForDelegation(mb, id, {
      onProgress: () => {},
      onDecision: async () => undefined,
      sleep: scripted((tick) => {
        if (tick === 1) {
          claim();
          mb.appendEvent(id, "project", { kind: "decision_request", decisionId: "d1", decisionKind: "clarification", question: "which env?" });
        }
        if (tick === 3) mb.writeResponse({ protocol: "omp-delegation/v1", delegationId: id, project: "acme/shop/dev", status: "stalled" });
      }),
    });
    expect(mb.pendingDecisions(id).map((d) => d.decisionId)).toEqual(["d1"]);
  });

  test("an abort cancels the request", async () => {
    const ac = new AbortController();
    const out = await waitForDelegation(mb, id, {
      onProgress: () => {},
      onDecision: async () => undefined,
      signal: ac.signal,
      sleep: scripted(() => ac.abort()),
    });
    expect(out).toEqual({ kind: "cancelled" });
    expect(mb.isCancelled(id)).toBe(true);
  });

  test("with stopOnDecision, a question ends the wait instead of opening a dialog", async () => {
    let dialogs = 0;
    const out = await waitForDelegation(mb, id, {
      onProgress: () => {},
      onDecision: async () => {
        dialogs += 1;
        return "yes";
      },
      stopOnDecision: true,
      sleep: scripted((tick) => {
        if (tick === 1) {
          claim();
          mb.appendEvent(id, "project", { kind: "decision_request", decisionId: "d1", decisionKind: "go_ahead", question: "deploy?" });
        }
      }),
    });
    expect(out).toEqual({ kind: "decision", event: expect.objectContaining({ decisionId: "d1", question: "deploy?" }) });
    expect(dialogs).toBe(0);
  });
});

describe("waitForAnswer", () => {
  test("returns the matching answer", async () => {
    const answer = await waitForAnswer(mb, id, "d2", {
      sleep: scripted((tick) => {
        if (tick === 1) mb.appendEvent(id, "main", { kind: "decision_answer", decisionId: "d1", answer: "no" });
        if (tick === 2) mb.appendEvent(id, "main", { kind: "decision_answer", decisionId: "d2", answer: "staging" });
      }),
    });
    expect(answer).toBe("staging");
  });

  test("gives up when the delegation is cancelled", async () => {
    const answer = await waitForAnswer(mb, id, "d1", { sleep: scripted(() => mb.cancel(id)) });
    expect(answer).toBeUndefined();
  });
});

describe("waitForTranscript", () => {
  const mark = (body: string) => {
    mkdirSync(join(root, "responses"), { recursive: true });
    writeFileSync(join(root, "responses", `${id}.transcript.json`), body);
    writeFileSync(join(root, "responses", `${id}.transcript.ready`), "");
  };
  test("returns the transcript once the marker appears", async () => {
    const t = await waitForTranscript(mb, id, { sleep: scripted((tick) => tick === 3 && mark('[{"role":"user","text":"x"}]')) });
    expect(t).toEqual([{ role: "user", text: "x" }]);
  });
  test("gives up with undefined after the retries", async () => {
    expect(await waitForTranscript(mb, id, { tries: 3, sleep: scripted(() => {}) })).toBeUndefined();
  });
  test("a corrupt transcript never throws", async () => {
    mark("{not json");
    expect(await waitForTranscript(mb, id, { tries: 3, sleep: scripted(() => {}) })).toBeUndefined();
  });
});
