export type Mode = "execute" | "ask";

export interface Criterion {
  id: string;
  check: string;
}

export interface RepoSnapshot {
  branch?: string;
  dirty: boolean;
  changedFiles: string[];
  fingerprint: string;
}

export interface DelegationRequest {
  protocol: "omp-delegation/v1";
  delegationId: string;
  mode: Mode;
  sync: boolean;
  /** `<org>/<project>`. */
  project: string;
  role: string;
  /** `<org>/<project>/<role>`: the resident agent's key. */
  agentKey: string;
  writes: boolean;
  repo: string;
  repoPath: string;
  cwd: string;
  git: boolean;
  /** Full launch string, already shell-quoted; the plugin never parses agent.yml. */
  command: string;
  objective: string;
  criteria: Criterion[];
  /** Role must-not rules plus the request's own. */
  mustNot: string[];
  context: {
    workCompleted?: string[];
    findings?: string[];
    hypothesis?: string;
    relevantFiles?: string[];
    constraints?: string[];
  };
  readOnlyPaths: string[];
  repository: RepoSnapshot;
  parent: { ternPane: number };
  handoff: string;
  createdAt: string;
}

export interface CriterionResult {
  id: string;
  status: "met" | "not_met" | "blocked";
  evidence: string;
}

export interface MustNotResult {
  rule: string;
  respected: boolean;
  evidence: string;
}

export interface DelegationReturn {
  delegationId: string;
  status: "completed" | "failed";
  summary: string;
  criteria: CriterionResult[];
  mustNot: MustNotResult[];
  findings: string[];
  changes: string[];
  tests: { commands: string[]; passed?: number; failed?: number; notes?: string };
  risks: string[];
  nextStep?: string;
}

export type TerminalStatus = "completed" | "failed" | "cancelled" | "stalled" | "agent_exited";

export interface DelegationResponse {
  protocol: "omp-delegation/v1";
  delegationId: string;
  /** Agent key. */
  project: string;
  status: TerminalStatus;
  result?: DelegationReturn;
  reason?: string;
  lastMessage?: string;
}

export interface DecisionRequestEvent {
  kind: "decision_request";
  decisionId: string;
  decisionKind: "go_ahead" | "clarification";
  question: string;
  options?: string[];
}

export type DelegationEvent =
  | DecisionRequestEvent
  | { kind: "decision_answer"; decisionId: string; answer: string }
  | { kind: "approval_pending"; tool: string; reason: string }
  | { kind: "approval_resolved"; tool: string }
  | { kind: "status"; status: string; detail?: string };

export function validateCriteria(criteria: Criterion[], mustNot: string[]): string[] {
  const errs: string[] = [];
  if (criteria.length === 0) errs.push("at least one acceptance criterion is required");
  const seen = new Set<string>();
  for (const c of criteria) {
    if (!/^C\d+$/.test(c.id)) errs.push(`${c.id}: ids are C1, C2, …`);
    if (seen.has(c.id)) errs.push(`${c.id}: duplicate id`);
    seen.add(c.id);
    if (!c.check.trim()) errs.push(`${c.id}: check is empty`);
  }
  if (mustNot.some((m) => !m.trim())) errs.push("must-not rules cannot be empty");
  return errs;
}

export function validateReturn(
  req: { criteria: Criterion[]; mustNot: string[] },
  ret: Pick<DelegationReturn, "criteria" | "mustNot">,
): string[] {
  const errs: string[] = [];
  const asked = new Set(req.criteria.map((c) => c.id));
  for (const c of req.criteria) {
    const got = ret.criteria.find((x) => x.id === c.id);
    if (!got) errs.push(`${c.id}: no result`);
    else if (!got.evidence.trim()) errs.push(`${c.id}: evidence is empty`);
  }
  for (const x of ret.criteria) if (!asked.has(x.id)) errs.push(`${x.id}: not requested`);
  for (const rule of req.mustNot) {
    const got = ret.mustNot.find((m) => m.rule === rule);
    if (!got) errs.push(`must-not "${rule}": no result`);
    else if (!got.evidence.trim()) errs.push(`must-not "${rule}": evidence is empty`);
  }
  return errs;
}

export function parseTernPane(value: string | undefined): number {
  const pane = Number(value);
  if (!value || !Number.isSafeInteger(pane)) {
    throw new Error("Main is not running in a Tern pane (TERN_PANE unset); delegation needs Tern.");
  }
  return pane;
}
