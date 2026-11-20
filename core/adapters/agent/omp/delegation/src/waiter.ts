import type { Mailbox } from "./mailbox";
import type { DecisionRequestEvent, DelegationResponse } from "./protocol";

export type WaitOutcome =
  | { kind: "response"; response: DelegationResponse }
  | { kind: "no_tern_window" }
  | { kind: "cancelled" }
  | { kind: "decision"; event: DecisionRequestEvent };

export interface WaitHooks {
  onProgress: (text: string) => void;
  onDecision: (ev: DecisionRequestEvent) => Promise<string | undefined>;
  signal?: AbortSignal;
  pollMs?: number;
  claimTimeoutMs?: number;
  /** Return at the first unanswered question instead of calling onDecision (Phase 0 D-U1 fallback). */
  stopOnDecision?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForDelegation(mb: Mailbox, id: string, h: WaitHooks): Promise<WaitOutcome> {
  const sleep = h.sleep ?? realSleep;
  const now = h.now ?? Date.now;
  const pollMs = h.pollMs ?? 500;
  const claimDeadline = now() + (h.claimTimeoutMs ?? 10_000);
  const seen = new Set<string>();
  const asked = new Set<string>();
  for (;;) {
    if (h.signal?.aborted) {
      mb.cancel(id);
      return { kind: "cancelled" };
    }
    const response = mb.readResponse(id);
    if (response) return { kind: "response", response };
    if (!mb.isClaimed(id) && now() > claimDeadline) return { kind: "no_tern_window" };
    for (const ev of mb.readEvents(id, seen)) {
      if (ev.kind === "status") h.onProgress(ev.detail ? `${ev.status}: ${ev.detail}` : ev.status);
      else if (ev.kind === "approval_pending") h.onProgress(`⏸ needs your approval in its pane: ${ev.tool} ${ev.reason}`);
      else if (ev.kind === "approval_resolved") h.onProgress(`approval for ${ev.tool} answered`);
      else if (ev.kind === "decision_request" && !asked.has(ev.decisionId)) {
        if (h.stopOnDecision) return { kind: "decision", event: ev };
        asked.add(ev.decisionId);
        h.onProgress(`⏸ waiting for your decision: ${ev.question}`);
        const answer = await h.onDecision(ev);
        if (answer !== undefined) mb.appendEvent(id, "main", { kind: "decision_answer", decisionId: ev.decisionId, answer });
      }
    }
    await sleep(pollMs);
  }
}

export async function waitForAnswer(
  mb: Mailbox,
  id: string,
  decisionId: string,
  opts: { signal?: AbortSignal; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | undefined> {
  const sleep = opts.sleep ?? realSleep;
  const seen = new Set<string>();
  for (;;) {
    if (opts.signal?.aborted) return undefined;
    for (const ev of mb.readEvents(id, seen)) {
      if (ev.kind === "decision_answer" && ev.decisionId === decisionId) return ev.answer;
    }
    if (mb.isCancelled(id) || mb.readResponse(id)) return undefined;
    await sleep(opts.pollMs ?? 500);
  }
}

/** The plugin dumps the transcript after the response; wait for its marker. Unreadable or missing → undefined, never throws. */
export async function waitForTranscript(
  mb: Mailbox,
  id: string,
  opts: { tries?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<unknown[] | undefined> {
  const sleep = opts.sleep ?? realSleep;
  for (let i = 0; i < (opts.tries ?? 30); i++) {
    try {
      const t = mb.readTranscript(id);
      if (t) return t;
    } catch {}
    await sleep(opts.pollMs ?? 500);
  }
  return undefined;
}
