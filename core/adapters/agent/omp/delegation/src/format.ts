import type { DelegationRequest, DelegationResponse } from "./protocol";

export function formatResult(req: DelegationRequest, resp: DelegationResponse, warnings: string[]): string {
  const out = [`Delegation ${resp.delegationId} → ${resp.project}: ${resp.status}`];
  if (resp.reason) out.push(`Reason: ${resp.reason}`);
  if (resp.lastMessage) out.push(`Agent's last message: ${resp.lastMessage}`);
  const r = resp.result;
  if (r) {
    out.push(`Summary: ${r.summary}`, "", "Criteria (the agent's claim; you decide):");
    for (const c of req.criteria) {
      const got = r.criteria.find((x) => x.id === c.id);
      out.push(`- ${c.id} ${c.check} → claimed ${got?.status ?? "missing"}: ${got?.evidence ?? ""}`);
    }
    if (r.mustNot.length) {
      out.push("Must not:");
      for (const m of r.mustNot) out.push(`- ${m.rule} → ${m.respected ? "respected" : "VIOLATED"}: ${m.evidence}`);
    }
    if (r.changes.length) out.push(`Changes: ${r.changes.join(", ")}`);
    if (r.tests.commands.length) {
      out.push(`Tests: ${r.tests.commands.join("; ")} (passed ${r.tests.passed ?? "?"}, failed ${r.tests.failed ?? "?"})`);
    }
    if (r.findings.length) out.push(`Findings: ${r.findings.join("; ")}`);
    if (r.risks.length) out.push(`Risks: ${r.risks.join("; ")}`);
    if (r.nextStep) out.push(`Recommended next step: ${r.nextStep}`);
  }
  if (warnings.length) out.push("", "Cross-check warnings:", ...warnings.map((w) => `- ${w}`));
  out.push("", "Before continuing, state per criterion whether you accept it as met, citing the evidence.");
  return out.join("\n");
}

export function noTernWindowText(req: DelegationRequest): string {
  return `No Tern window holds this Main pane (${req.parent.ternPane}), or the omp-delegation Tern plugin is not loaded (./setup verify); ${req.delegationId} stays queued and starts when one does. Check it with delegation_status.`;
}
