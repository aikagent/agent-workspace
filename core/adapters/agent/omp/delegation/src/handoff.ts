import type { DelegationRequest } from "./protocol";

export function buildHandoff(r: Omit<DelegationRequest, "handoff">): string {
  const repo = r.repository;
  const state = repo.dirty ? `dirty: ${repo.changedFiles.slice(0, 20).join(", ")}` : "clean";
  const lines = [
    `[omp-delegation/v1 ${r.delegationId}] agent=${r.agentKey} mode=${r.mode} from the Main session`,
    `This is a delegated task: skip any session-start protocol in this project's instructions (health check, task list, "ask the user"); work on this task only.`,
    `Target checkout: ${r.repoPath} (branch ${repo.branch ?? "n/a"}, ${state})`,
    `Objective: ${r.objective}`,
  ];
  const c = r.context;
  if (c.workCompleted?.length) lines.push(`Work already done: ${c.workCompleted.join("; ")}`);
  if (c.findings?.length) lines.push(`Findings: ${c.findings.join("; ")}`);
  if (c.hypothesis) lines.push(`Hypothesis: ${c.hypothesis}`);
  if (c.relevantFiles?.length) lines.push(`Relevant files: ${c.relevantFiles.join(", ")}`);
  if (c.constraints?.length) lines.push(`Constraints: ${c.constraints.join("; ")}`);
  lines.push("Acceptance criteria (report evidence for each):", ...r.criteria.map((x) => `  ${x.id}: ${x.check}`));
  if (r.mustNot.length) lines.push("Must not:", ...r.mustNot.map((m) => `  - ${m}`));
  if (r.mode === "ask") lines.push("Answer only: do not modify any file.");
  const readOnly = r.readOnlyPaths.length ? `; read-only paths: ${r.readOnlyPaths.join(", ")}` : "";
  lines.push(
    r.writes
      ? `Rules: continue from the current files; trust the handoff unless the repository contradicts it; edit only inside the target checkout${readOnly}; run relevant tests; do not commit unless told.`
      : `Rules: continue from the current files; trust the handoff unless the repository contradicts it; you change no files yourself; run only the commands this task names, each behind the approval prompt${readOnly}.`,
    `To ask the user anything, call request_decision with delegation_id ${r.delegationId}; never end your turn to ask.`,
    `Finish only by calling return_delegation with delegation_id ${r.delegationId}, giving evidence for every criterion and must-not rule.`,
  );
  return lines.join("\n");
}
