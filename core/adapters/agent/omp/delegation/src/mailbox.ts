import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDelegationId } from "./ids";
import type { DecisionRequestEvent, DelegationEvent, DelegationRequest, DelegationResponse } from "./protocol";

export const MAX_BYTES = 64 * 1024;
const TRANSCRIPT_MAX = 4 * 1024 * 1024;
const DIRS = ["requests", "claims", "events", "responses", "status", "active"];
const KEY_RE = /^[a-z][a-z0-9-]{0,31}\/[a-z][a-z0-9-]{0,31}\/[a-z][a-z0-9-]{0,31}$/;

function checkId(id: string): void {
  if (!isDelegationId(id)) throw new Error(`invalid delegation id: ${JSON.stringify(id)}`);
}

function atomicWrite(file: string, text: string): void {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${file}: larger than ${MAX_BYTES} bytes`);
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function readJson<T>(file: string, max = MAX_BYTES): T | undefined {
  if (!existsSync(file)) return undefined;
  if (statSync(file).size > max) throw new Error(`${file}: larger than ${max} bytes`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export class Mailbox {
  constructor(readonly root: string) {}

  /** Creates the root and every missing parent privately (0700): requests carry handoffs and transcripts. */
  ensure(): void {
    for (const d of DIRS) mkdirSync(join(this.root, d), { recursive: true, mode: 0o700 });
  }

  private file(dir: string, name: string): string {
    return join(this.root, dir, name);
  }

  private marked(dir: string, base: string, value: unknown, marker: string): void {
    this.ensure();
    atomicWrite(this.file(dir, `${base}.json`), JSON.stringify(value));
    writeFileSync(this.file(dir, `${base}${marker}`), "");
  }

  writeRequest(req: DelegationRequest): void {
    checkId(req.delegationId);
    this.marked("requests", req.delegationId, req, ".ready");
  }

  readRequest(id: string): DelegationRequest | undefined {
    checkId(id);
    if (!existsSync(this.file("requests", `${id}.ready`))) return undefined;
    return readJson<DelegationRequest>(this.file("requests", `${id}.json`));
  }

  listRequests(): string[] {
    this.ensure();
    return readdirSync(join(this.root, "requests"))
      .filter((n) => n.endsWith(".ready"))
      .map((n) => n.slice(0, -".ready".length))
      .filter(isDelegationId)
      .sort();
  }

  cancel(id: string): void {
    checkId(id);
    this.ensure();
    writeFileSync(this.file("requests", `${id}.cancel`), "");
  }

  isCancelled(id: string): boolean {
    checkId(id);
    return existsSync(this.file("requests", `${id}.cancel`));
  }

  isClaimed(id: string): boolean {
    checkId(id);
    return existsSync(this.file("claims", `${id}.json`));
  }

  appendEvent(id: string, writer: string, ev: DelegationEvent): string {
    checkId(id);
    const dir = join(this.root, "events", id);
    mkdirSync(dir, { recursive: true });
    const base = `${String(Date.now()).padStart(13, "0")}-${writer}-${Math.random().toString(36).slice(2, 8)}`;
    atomicWrite(join(dir, `${base}.json`), JSON.stringify(ev));
    writeFileSync(join(dir, `${base}.ready`), "");
    return base;
  }

  readEvents(id: string, seen: Set<string>): DelegationEvent[] {
    checkId(id);
    const dir = join(this.root, "events", id);
    if (!existsSync(dir)) return [];
    const out: DelegationEvent[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ready")).sort()) {
      const base = name.slice(0, -".ready".length);
      if (seen.has(base)) continue;
      const ev = readJson<DelegationEvent>(join(dir, `${base}.json`));
      if (!ev) continue;
      seen.add(base);
      out.push(ev);
    }
    return out;
  }

  pendingDecisions(id: string): DecisionRequestEvent[] {
    const events = this.readEvents(id, new Set());
    const answered = new Set(events.flatMap((e) => (e.kind === "decision_answer" ? [e.decisionId] : [])));
    return events.filter((e): e is DecisionRequestEvent => e.kind === "decision_request" && !answered.has(e.decisionId));
  }

  writeResponse(resp: DelegationResponse): void {
    checkId(resp.delegationId);
    if (this.readResponse(resp.delegationId)) throw new Error(`${resp.delegationId} already has a response`);
    this.marked("responses", resp.delegationId, resp, ".done");
  }

  readResponse(id: string): DelegationResponse | undefined {
    checkId(id);
    if (!existsSync(this.file("responses", `${id}.done`))) return undefined;
    return readJson<DelegationResponse>(this.file("responses", `${id}.json`));
  }

  readTranscript(id: string): unknown[] | undefined {
    checkId(id);
    if (!existsSync(this.file("responses", `${id}.transcript.ready`))) return undefined;
    return readJson<unknown[]>(this.file("responses", `${id}.transcript.json`), TRANSCRIPT_MAX);
  }

  readStatus(id: string): { status: string; detail?: string } | undefined {
    checkId(id);
    return readJson(this.file("status", `${id}.json`));
  }

  /** Active delegation of an agent key (`org/project/role`); the file is `org.project.role.json`. */
  activeFor(agentKey: string): string | undefined {
    if (!KEY_RE.test(agentKey)) throw new Error(`invalid agent key: ${JSON.stringify(agentKey)}`);
    return readJson<{ delegationId: string }>(this.file("active", `${agentKey.replaceAll("/", ".")}.json`))?.delegationId;
  }
}

