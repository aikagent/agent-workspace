import type { Mailbox } from "./mailbox";

export interface NotifierState {
  /** Sync requests this process is blocked on: their tool call reports them. */
  waiting: Set<string>;
  /** Ids that never need another look: finished, announced, or another pane's. */
  skip: Set<string>;
}

/** Announces async decisions and finishes for this pane. Skipped ids are never read again. */
export function createNotifier(mb: Mailbox, mine: number, state: NotifierState, notify: (msg: string, level: "info" | "warning") => void) {
  for (const id of mb.listRequests()) if (mb.readResponse(id)) state.skip.add(id);
  const announced = new Set<string>();
  return {
    tick(): void {
      for (const id of mb.listRequests()) {
        if (state.skip.has(id) || state.waiting.has(id)) continue;
        const req = mb.readRequest(id);
        if (!req) continue;
        if (req.parent.ternPane !== mine) {
          state.skip.add(id);
          continue;
        }
        for (const ev of mb.pendingDecisions(id)) {
          if (announced.has(ev.decisionId)) continue;
          announced.add(ev.decisionId);
          notify(`${req.agentKey} (${id}) asks: ${ev.question} → /delegation answer ${id}`, "warning");
        }
        const resp = mb.readResponse(id);
        if (resp) {
          state.skip.add(id);
          notify(`${req.agentKey} finished ${id}: ${resp.status}. Read it with delegation_result.`, "info");
        }
      }
    },
  };
}

/** The newest `n` request ids started from pane `mine`, reading newest-first and stopping once there are enough. */
export function recentForPane(mb: Mailbox, mine: number, n: number): string[] {
  const out: string[] = [];
  const ids = mb.listRequests();
  for (let i = ids.length - 1; i >= 0 && out.length < n; i--) {
    if (mb.readRequest(ids[i])?.parent.ternPane === mine) out.unshift(ids[i]);
  }
  return out;
}
