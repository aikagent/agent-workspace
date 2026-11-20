import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { Mailbox } from "./mailbox";
import { validateReturn, type DelegationReturn } from "./protocol";
import { waitForAnswer } from "./waiter";

/** `agentKey` is `<org>/<project>/<role>`, from OMP_DELEGATION_PROJECT. */
export function registerProjectSide(pi: ExtensionAPI, agentKey: string, mb: Mailbox): void {
  const z = pi.zod;

  const requireActive = (id: string) => {
    if (mb.activeFor(agentKey) !== id) throw new Error(`${id} is not the active delegation for ${agentKey}`);
    const req = mb.readRequest(id);
    if (!req) throw new Error(`${id}: request not found`);
    return req;
  };

  pi.registerTool({
    name: "request_decision",
    loadMode: "essential",
    label: "Request decision",
    description:
      "During a delegated task, ask the user (through the Main session) for a go-ahead or a clarification. Use this instead of ending your turn to ask. Blocks until they answer; returns the answer.",
    parameters: z.object({
      delegation_id: z.string(),
      kind: z.enum(["go_ahead", "clarification"]),
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
    }),
    async execute(_callId, p, signal) {
      requireActive(p.delegation_id);
      const decisionId = randomUUID();
      mb.appendEvent(p.delegation_id, "project", {
        kind: "decision_request",
        decisionId,
        decisionKind: p.kind,
        question: p.question,
        options: p.options,
      });
      const answer = await waitForAnswer(mb, p.delegation_id, decisionId, { signal });
      const text = answer === undefined ? "No answer: the delegation was cancelled or ended." : `The user answered: ${answer}`;
      return { content: [{ type: "text", text }], details: { decisionId, answer } };
    },
  });

  pi.registerTool({
    name: "return_delegation",
    loadMode: "essential",
    label: "Return delegation",
    description:
      "Finish a delegated task and hand the result back to the Main session. Give a result and non-empty evidence for every requested criterion (C1, C2…) and every must-not rule, copying the rule text exactly.",
    parameters: z.object({
      delegation_id: z.string(),
      status: z.enum(["completed", "failed"]),
      summary: z.string().min(1),
      criteria: z.array(z.object({ id: z.string(), status: z.enum(["met", "not_met", "blocked"]), evidence: z.string() })),
      must_not: z.array(z.object({ rule: z.string(), respected: z.boolean(), evidence: z.string() })),
      findings: z.array(z.string()).optional(),
      changes: z.array(z.string()).optional(),
      tests: z
        .object({ commands: z.array(z.string()), passed: z.number().optional(), failed: z.number().optional(), notes: z.string().optional() })
        .optional(),
      risks: z.array(z.string()).optional(),
      next_step: z.string().optional(),
    }),
    async execute(_callId, p) {
      const req = requireActive(p.delegation_id);
      const ret: DelegationReturn = {
        delegationId: p.delegation_id,
        status: p.status,
        summary: p.summary,
        criteria: p.criteria,
        mustNot: p.must_not,
        findings: p.findings ?? [],
        changes: p.changes ?? [],
        tests: p.tests ?? { commands: [] },
        risks: p.risks ?? [],
        nextStep: p.next_step,
      };
      const errors = validateReturn(req, ret);
      if (errors.length) {
        throw new Error(
          `Return rejected, call return_delegation again with: ${errors.join("; ")}. Requested criteria: ${req.criteria.map((c) => `${c.id} ${c.check}`).join(" | ")}. Must-not rules: ${req.mustNot.join(" | ") || "none"}.`,
        );
      }
      mb.writeResponse({ protocol: "omp-delegation/v1", delegationId: p.delegation_id, project: agentKey, status: ret.status, result: ret });
      return { content: [{ type: "text", text: "Returned to the Main session. Stop here; do not continue this task." }], details: {} };
    },
  });

  pi.on("tool_approval_requested", (event: { toolName?: string; reason?: string }) => {
    const id = mb.activeFor(agentKey);
    if (id) mb.appendEvent(id, "project", { kind: "approval_pending", tool: event?.toolName ?? "tool", reason: event?.reason ?? "" });
  });

  pi.on("tool_approval_resolved", (event: { toolName?: string }) => {
    const id = mb.activeFor(agentKey);
    if (id) mb.appendEvent(id, "project", { kind: "approval_resolved", tool: event?.toolName ?? "tool" });
  });
}
