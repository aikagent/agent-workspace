import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadAgents, resolveTarget } from "./agents";
import { crossCheck, sliceFromHandoff, toolCallsFromTranscript, type TranscriptMessage } from "./crosscheck";
import { formatResult, noTernWindowText } from "./format";
import { buildHandoff } from "./handoff";
import { newDelegationId } from "./ids";
import type { Mailbox } from "./mailbox";
import { createNotifier, recentForPane } from "./notifier";
import { parseTernPane, validateCriteria, type Criterion, type DecisionRequestEvent, type DelegationRequest, type DelegationResponse, type Mode } from "./protocol";
import { snapshot } from "./snapshot";
import { waitForDelegation, waitForTranscript, type WaitOutcome } from "./waiter";

const OTHER = "Other (type an answer)";
const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

interface PrepareInput {
  project: string;
  role?: string;
  objective: string;
  repo?: string;
  criteria: Criterion[];
  mustNot: string[];
  context?: DelegationRequest["context"];
}

/** `<project>[:<role>]`, the argument form of /delegate, /ask and /dispatch. */
function splitTarget(arg: string): { project: string; role?: string } {
  const i = arg.lastIndexOf(":");
  return i > 0 ? { project: arg.slice(0, i), role: arg.slice(i + 1) } : { project: arg };
}

export function registerMainSide(pi: ExtensionAPI, mb: Mailbox, root: string): void {
  const z = pi.zod;
  const criterion = z.object({ id: z.string(), check: z.string() });
  const role = z.string().optional();
  const context = z
    .object({
      workCompleted: z.array(z.string()).optional(),
      findings: z.array(z.string()).optional(),
      hypothesis: z.string().optional(),
      relevantFiles: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
    })
    .optional();

  function prepare(input: PrepareInput, mode: Mode, sync: boolean, cwd: string): DelegationRequest {
    const ternPane = parseTernPane(process.env.TERN_PANE);
    const errs = validateCriteria(input.criteria, input.mustNot);
    if (errs.length) throw new Error(errs.join("; "));
    const loadErrors: string[] = [];
    const t = resolveTarget(loadAgents(root, loadErrors), input.project, input.role, mode, input.repo, cwd, loadErrors);
    const req: Omit<DelegationRequest, "handoff"> = {
      protocol: "omp-delegation/v1",
      delegationId: newDelegationId(),
      mode,
      sync,
      project: `${t.org}/${t.project}`,
      role: t.role,
      agentKey: t.key,
      writes: t.writes,
      repo: input.repo ?? ".",
      repoPath: t.repoPath,
      cwd: t.cwd,
      git: t.git,
      command: t.launch,
      objective: input.objective,
      criteria: input.criteria,
      mustNot: [...new Set([...t.mustNot, ...input.mustNot])],
      context: input.context ?? {},
      readOnlyPaths: t.readOnlyPaths,
      repository: snapshot(t.repoPath, t.git),
      parent: { ternPane },
      createdAt: new Date().toISOString(),
    };
    return { ...req, handoff: buildHandoff(req) };
  }

  async function askUser(ctx: any, agentKey: string, ev: DecisionRequestEvent): Promise<string | undefined> {
    if (!ctx.hasUI) return undefined;
    const title = `${agentKey} asks (${ev.decisionKind}): ${ev.question}`;
    const options = ev.options?.length ? ev.options : ev.decisionKind === "go_ahead" ? ["Yes, go ahead", "No"] : [];
    if (options.length === 0) return ctx.ui.input(title);
    const pick = await ctx.ui.select(title, [...options, OTHER]);
    return pick === OTHER ? ctx.ui.input(title) : pick;
  }

  async function report(req: DelegationRequest, resp: DelegationResponse): Promise<string> {
    const warnings: string[] = [];
    if (resp.status === "completed" && resp.result) {
      const all = (await waitForTranscript(mb, req.delegationId)) as TranscriptMessage[] | undefined;
      const mine = all && sliceFromHandoff(all, req.delegationId);
      if (mine) warnings.push(...crossCheck(resp.result, toolCallsFromTranscript(mine), req.readOnlyPaths, req.writes));
      else warnings.push("transcript unavailable: claims were not cross-checked");
    }
    if (req.mode === "ask" && snapshot(req.repoPath, req.git).fingerprint !== req.repository.fingerprint) {
      warnings.push("files in the target checkout changed during a read-only ask (the agent or someone else edited them)");
    }
    return formatResult(req, resp, warnings);
  }

  async function finish(req: DelegationRequest, outcome: WaitOutcome) {
    if (outcome.kind === "no_tern_window") {
      return text(noTernWindowText(req), { delegationId: req.delegationId });
    }
    if (outcome.kind === "decision") {
      throw new Error("unreachable: stopOnDecision is not used");
    }
    if (outcome.kind === "cancelled") return text(`Cancelled ${req.delegationId}.`, { delegationId: req.delegationId });
    return text(await report(req, outcome.response), { delegationId: req.delegationId, response: outcome.response });
  }

  // Sync requests this process blocks on report through their own tool call; the notifier leaves them alone.
  const notifierState = { waiting: new Set<string>(), skip: new Set<string>() };

  async function run(req: DelegationRequest, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
    mb.writeRequest(req);
    notifierState.waiting.add(req.delegationId);
    try {
      const outcome = await waitForDelegation(mb, req.delegationId, {
        onProgress: (t) => onUpdate?.({ content: [{ type: "text", text: `${req.agentKey}: ${t}` }] }),
        onDecision: (ev) => askUser(ctx, req.agentKey, ev),
        signal,
      });
      // After no_tern_window the request stays queued: let the notifier surface it later.
      if (outcome.kind !== "no_tern_window") notifierState.skip.add(req.delegationId);
      return await finish(req, outcome);
    } finally {
      notifierState.waiting.delete(req.delegationId);
    }
  }

  pi.registerTool({
    name: "delegate_project",
    label: "Delegate to project",
    description:
      "Hand a bounded unit of work to the resident omp agent of another project and wait for its structured result. `project` is `org/project` (or a bare id when unambiguous); `role` defaults to dev. Give numbered acceptance criteria (C1, C2…) with concrete checks and must-not rules. Only you decide whether a criterion is met, from the evidence returned.",
    parameters: z.object({
      project: z.string(),
      role,
      objective: z.string().min(1),
      criteria: z.array(criterion),
      mustNot: z.array(z.string()).optional(),
      repo: z.string().optional(),
      context,
    }),
    async execute(_id, p, signal, onUpdate, ctx: any) {
      return run(prepare({ ...p, mustNot: p.mustNot ?? [] }, "execute", true, ctx.cwd), signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    name: "ask_project",
    label: "Ask project",
    description:
      "Ask another project's resident agent a question (role defaults to support). It investigates without modifying files and returns findings with evidence.",
    parameters: z.object({ project: z.string(), role, question: z.string().min(1), repo: z.string().optional() }),
    async execute(_id, p, signal, onUpdate, ctx: any) {
      const req = prepare(
        {
          project: p.project,
          role: p.role,
          objective: p.question,
          repo: p.repo,
          criteria: [{ id: "C1", check: "The question is answered with evidence from the repository" }],
          mustNot: ["Do not modify any file"],
        },
        "ask",
        true,
        ctx.cwd,
      );
      return run(req, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    name: "dispatch_project",
    label: "Dispatch to project",
    description:
      "Start work in another project's resident agent without waiting (for example a nightly batch in an ops role). Returns the delegation id at once; you are notified of decisions and completion.",
    parameters: z.object({
      project: z.string(),
      role,
      objective: z.string().min(1),
      criteria: z.array(criterion),
      mustNot: z.array(z.string()).optional(),
      repo: z.string().optional(),
      context,
    }),
    async execute(_id, p, _signal, _onUpdate, ctx: any) {
      const req = prepare({ ...p, mustNot: p.mustNot ?? [] }, "execute", false, ctx.cwd);
      mb.writeRequest(req);
      return text(`Dispatched ${req.delegationId} to ${req.agentKey}. Check it with delegation_status or delegation_result.`, { delegationId: req.delegationId });
    },
  });

  pi.registerTool({
    name: "delegation_status",
    label: "Delegation status",
    description: "Status of one delegation, or of the latest delegations started from this Main pane.",
    parameters: z.object({ id: z.string().optional() }),
    async execute(_id, p) {
      return text(statusLines(p.id).join("\n") || "No delegations from this pane.");
    },
  });

  pi.registerTool({
    name: "delegation_result",
    label: "Delegation result",
    description: "The structured result of a finished delegation, with cross-check warnings.",
    parameters: z.object({ id: z.string() }),
    async execute(_id, p) {
      const req = mb.readRequest(p.id);
      if (!req) throw new Error(`${p.id}: no such delegation`);
      const resp = mb.readResponse(p.id);
      if (!resp) return text(`${p.id} is not finished: ${mb.readStatus(p.id)?.status ?? "queued"}`);
      return text(await report(req, resp), { response: resp });
    },
  });

  function statusLines(id?: string): string[] {
    const mine = Number(process.env.TERN_PANE);
    const ids = id ? [id] : recentForPane(mb, mine, 10);
    return ids.map((x) => {
      const req = mb.readRequest(x);
      const resp = mb.readResponse(x);
      const status = resp?.status ?? mb.readStatus(x)?.status ?? (mb.isClaimed(x) ? "claimed" : "queued");
      const pending = mb.pendingDecisions(x).length;
      return `${x} ${req?.agentKey ?? "?"} ${status}${pending ? ` (${pending} decision waiting: /delegation answer ${x})` : ""}`;
    });
  }

  const steer = (instruction: string) => pi.sendUserMessage(instruction);
  const targetArgs = (args: string) => {
    const [first, ...rest] = args.trim().split(/\s+/);
    return { ...splitTarget(first ?? ""), rest: rest.join(" ") };
  };
  const roleArg = (t: { role?: string }) => (t.role ? ` and role "${t.role}"` : "");

  pi.registerCommand("delegate", {
    description: "Delegate current work to a project agent: /delegate <project>[:<role>] [instruction]",
    handler: async (args: string) => {
      const t = targetArgs(args);
      if (!t.project) return;
      steer(
        `Delegate ${t.rest ? `"${t.rest}"` : "the appropriate part of the current work"} to project "${t.project}"${roleArg(t)}. Build a concise handoff from what we have done so far (work completed, findings, hypothesis, relevant files, constraints), write numbered acceptance criteria (C1, C2…) each with a concrete check, and must-not rules, then call delegate_project. When it returns, state per criterion whether you accept it as met from the evidence, then continue the task.`,
      );
    },
  });

  pi.registerCommand("ask", {
    description: "Ask a project agent a question without edits: /ask <project>[:<role>] <question>",
    handler: async (args: string) => {
      const t = targetArgs(args);
      if (t.project && t.rest) steer(`Call ask_project with project "${t.project}"${roleArg(t)} and question: ${t.rest}`);
    },
  });

  pi.registerCommand("dispatch", {
    description: "Start work in a project agent without waiting: /dispatch <project>[:<role>] <instruction>",
    handler: async (args: string) => {
      const t = targetArgs(args);
      if (t.project && t.rest) {
        steer(`Call dispatch_project for project "${t.project}"${roleArg(t)} with objective "${t.rest}", numbered acceptance criteria with concrete checks, and must-not rules.`);
      }
    },
  });

  pi.registerCommand("projects", {
    description: "List delegation targets: org/project: role (writes|read-only)",
    handler: async (_args: string, ctx: any) => {
      const by = new Map<string, string[]>();
      const loadErrors: string[] = [];
      for (const a of loadAgents(root, loadErrors)) {
        const k = `${a.org}/${a.project}`;
        by.set(k, [...(by.get(k) ?? []), `${a.role} (${a.writes ? "writes" : "read-only"})`]);
      }
      const lines = [...by].sort().map(([k, roles]) => `${k}: ${roles.join(", ")}`);
      if (loadErrors.length) lines.push("", "Skipped malformed agent files:", ...loadErrors);
      ctx.ui.notify(lines.join("\n") || "No project agents.", loadErrors.length ? "warning" : "info");
    },
  });

  pi.registerCommand("delegations", {
    description: "Delegations started from this pane",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(statusLines().join("\n") || "No delegations from this pane.", "info");
    },
  });

  pi.registerCommand("delegation", {
    description: "/delegation answer <id> | /delegation cancel <id>",
    handler: async (args: string, ctx: any) => {
      const [verb, id] = args.trim().split(/\s+/);
      const req = id ? mb.readRequest(id) : undefined;
      if (!req) return ctx.ui.notify(`Unknown delegation: ${id ?? "(none)"}`, "error");
      if (verb === "cancel") {
        mb.cancel(id);
        return ctx.ui.notify(`Cancel requested for ${id}.`, "info");
      }
      if (verb === "answer") {
        const ev = mb.pendingDecisions(id)[0];
        if (!ev) return ctx.ui.notify(`${id} has no decision waiting.`, "info");
        const answer = await askUser(ctx, req.agentKey, ev);
        if (answer !== undefined) mb.appendEvent(id, "main", { kind: "decision_answer", decisionId: ev.decisionId, answer });
        return;
      }
      ctx.ui.notify("Usage: /delegation answer <id> | /delegation cancel <id>", "error");
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    const mine = Number(process.env.TERN_PANE);
    if (!Number.isSafeInteger(mine)) return;
    const notifier = createNotifier(mb, mine, notifierState, (m, level) => ctx.ui.notify(m, level));
    ctx.setInterval(() => notifier.tick(), 2000);
  });
}
