import type { DelegationReturn } from "./protocol";

export interface TranscriptMessage {
  role: string;
  text: string;
  tools?: Array<Record<string, unknown>>;
}

export interface ToolCall {
  name: string;
  command?: string;
  path?: string;
  ok: boolean;
}

const EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);
const FAILED = new Set(["error", "failed", "failure"]);
const GIT_COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;

// Tern transcript tool entries (probe U6): bash has `command`; file tools have the path in `target`; a failure has status "error".
export function toolCallsFromTranscript(messages: TranscriptMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of messages) {
    for (const t of m.tools ?? []) {
      const name = String(t.name ?? "").toLowerCase();
      const target = typeof t.target === "string" ? t.target : undefined;
      const command = typeof t.command === "string" ? t.command : undefined;
      const ok = !FAILED.has(String(t.status ?? "").toLowerCase());
      if (name === "bash") calls.push({ name, command, ok });
      else calls.push({ name, path: EDIT_TOOLS.has(name) ? target : undefined, ok });
    }
  }
  return calls;
}

export function crossCheck(ret: DelegationReturn, calls: ToolCall[], readOnlyPaths: string[], writes = true): string[] {
  const warnings: string[] = [];
  const bash = calls.filter((c): c is ToolCall & { command: string } => c.name === "bash" && !!c.command);
  for (const cmd of ret.tests.commands) {
    const hits = bash.filter((c) => c.command.includes(cmd.trim()));
    if (hits.length === 0) warnings.push(`claimed test "${cmd}" has no matching bash call`);
    else if (!hits.some((c) => c.ok)) warnings.push(`claimed test "${cmd}" ran but every matching call failed`);
  }
  const edits = calls.filter((c): c is ToolCall & { path: string } => EDIT_TOOLS.has(c.name) && !!c.path);
  for (const f of ret.changes) {
    if (!edits.some((e) => e.path.endsWith(f) || f.endsWith(e.path))) warnings.push(`claimed change "${f}" has no edit/write call`);
  }
  const noCommit = ret.mustNot.find((m) => /commit/i.test(m.rule) && m.respected);
  if (noCommit) {
    for (const c of bash) if (GIT_COMMIT.test(c.command)) warnings.push(`"${c.command}" contradicts must-not "${noCommit.rule}"`);
  }
  if (!writes) for (const e of calls.filter((c) => EDIT_TOOLS.has(c.name))) warnings.push(`read-only role called ${e.name}${e.path ? ` on "${e.path}"` : ""}`);
  for (const e of edits) {
    for (const ro of readOnlyPaths) {
      if (e.path.includes(`/${ro}/`) || e.path.startsWith(`${ro}/`)) warnings.push(`edit of "${e.path}" is under read-only path "${ro}"`);
    }
  }
  return warnings;
}

/** The part of a (possibly long, unsliced) transcript that belongs to one delegation: from its last handoff message on. */
export function sliceFromHandoff(messages: TranscriptMessage[], id: string): TranscriptMessage[] | undefined {
  const marker = `[omp-delegation/v1 ${id}]`;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].text.includes(marker)) return messages.slice(i);
  }
  return undefined;
}
