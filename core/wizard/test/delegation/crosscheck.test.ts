import { crossCheck, sliceFromHandoff, toolCallsFromTranscript, type ToolCall } from "../../../adapters/agent/omp/delegation/src/crosscheck";
import type { DelegationReturn } from "../../../adapters/agent/omp/delegation/src/protocol";

const ret = (over: Partial<DelegationReturn> = {}): DelegationReturn => ({
  delegationId: "dlg_x",
  status: "completed",
  summary: "fixed",
  criteria: [],
  mustNot: [{ rule: "no commits", respected: true, evidence: "none made" }],
  findings: [],
  changes: ["src/services/lean/verify.ts"],
  tests: { commands: ["pytest tests/services/lean"] },
  risks: [],
  ...over,
});

const honest: ToolCall[] = [
  { name: "edit", path: "/repo/src/services/lean/verify.ts", ok: true },
  { name: "bash", command: "cd /repo && pytest tests/services/lean -q", ok: true },
];

describe("crossCheck", () => {
  test("no warnings when the transcript backs every claim", () => {
    expect(crossCheck(ret(), honest, [])).toEqual([]);
  });

  test("a claimed test with no bash call", () => {
    expect(crossCheck(ret(), [honest[0]], [])).toContain('claimed test "pytest tests/services/lean" has no matching bash call');
  });

  test("a claimed test whose every call failed", () => {
    const calls = [honest[0], { ...honest[1], ok: false }];
    expect(crossCheck(ret(), calls, [])).toContain('claimed test "pytest tests/services/lean" ran but every matching call failed');
  });

  test("a claimed change with no edit", () => {
    expect(crossCheck(ret(), [honest[1]], [])).toContain('claimed change "src/services/lean/verify.ts" has no edit/write call');
  });

  test("a commit despite a respected no-commit rule", () => {
    const calls = [...honest, { name: "bash", command: "git -C /repo commit -m fix", ok: true }];
    expect(crossCheck(ret(), calls, [])).toContain('"git -C /repo commit -m fix" contradicts must-not "no commits"');
  });

  test("an edit under a read-only path", () => {
    const calls = [...honest, { name: "write", path: "/shop/repositories/onboarding/x.py", ok: true }];
    expect(crossCheck(ret(), calls, ["repositories"])).toContain('edit of "/shop/repositories/onboarding/x.py" is under read-only path "repositories"');
  });
});

describe("read-only roles", () => {
  test("any edit or write call is a warning", () => {
    const calls = [{ name: "edit", path: "/repo/a.ts", ok: false }];
    expect(crossCheck(ret({ changes: [], tests: { commands: [] } }), calls, [], false)).toContain('read-only role called edit on "/repo/a.ts"');
    expect(crossCheck(ret({ changes: [], tests: { commands: [] } }), calls, [], true)).toEqual([]);
  });
});

describe("toolCallsFromTranscript", () => {
  test("maps Tern tool entries", () => {
    const calls = toolCallsFromTranscript([
      { role: "assistant", text: "", tools: [
        { name: "bash", command: "pytest tests", exit: 0, target: "run tests", status: "done" },
        { name: "bash", command: "false", exit: 1, status: "error" },
        { name: "edit", target: "/repo/a.ts", status: "error" },
      ] },
    ]);
    expect(calls).toEqual([
      { name: "bash", command: "pytest tests", ok: true },
      { name: "bash", command: "false", ok: false },
      { name: "edit", path: "/repo/a.ts", ok: false },
    ]);
  });
});

describe("sliceFromHandoff", () => {
  const id = "dlg_01JCBF0NYV6QK8X4KFX9ABCDEF";
  const msg = (role: string, text: string) => ({ role, text });
  test("starts at the last user message carrying this delegation's handoff", () => {
    const m = [
      msg("user", `[omp-delegation/v1 ${id}] earlier`), msg("assistant", "old"),
      msg("user", `[omp-delegation/v1 dlg_OTHER] other`), msg("assistant", "x"),
      msg("user", `[omp-delegation/v1 ${id}] again`), msg("assistant", "new"),
    ];
    expect(sliceFromHandoff(m, id)?.map((x) => x.text)).toEqual([`[omp-delegation/v1 ${id}] again`, "new"]);
  });
  test("undefined when the handoff is not in the transcript", () => {
    expect(sliceFromHandoff([msg("user", "hi"), msg("assistant", `mentions [omp-delegation/v1 ${id}]`)], id)).toBeUndefined();
  });
});
