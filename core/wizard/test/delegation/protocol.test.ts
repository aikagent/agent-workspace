import { describe, expect, test } from "bun:test";
import { isDelegationId, newDelegationId } from "../../../adapters/agent/omp/delegation/src/ids";
import { parseTernPane, validateCriteria, validateReturn, type DelegationReturn } from "../../../adapters/agent/omp/delegation/src/protocol";

describe("delegation ids", () => {
  test("new ids are valid and sort by creation time", () => {
    const a = newDelegationId(1_700_000_000_000);
    const b = newDelegationId(1_700_000_000_001);
    expect(isDelegationId(a)).toBe(true);
    expect(a < b).toBe(true);
  });

  test("ids that could leave the mailbox directory are rejected", () => {
    for (const bad of ["dlg_../../etc/passwd", "dlg_", "x_01ARZ3NDEKTSV4RRFFQ69G5FAV", "dlg_01arz3ndektsv4rrffq69g5fav", 42]) {
      expect(isDelegationId(bad)).toBe(false);
    }
  });
});

describe("validateCriteria", () => {
  test("accepts numbered criteria with checks", () => {
    expect(validateCriteria([{ id: "C1", check: "pytest tests/lean passes" }], ["no commits"])).toEqual([]);
  });

  test("requires at least one criterion", () => {
    expect(validateCriteria([], [])).toContain("at least one acceptance criterion is required");
  });

  test("rejects bad ids, duplicates, empty checks and empty must-not rules", () => {
    const errs = validateCriteria(
      [{ id: "C1", check: "a" }, { id: "C1", check: "b" }, { id: "x", check: " " }],
      [" "],
    );
    expect(errs).toContain("C1: duplicate id");
    expect(errs).toContain("x: ids are C1, C2, …");
    expect(errs).toContain("x: check is empty");
    expect(errs).toContain("must-not rules cannot be empty");
  });
});

describe("validateReturn", () => {
  const req = {
    criteria: [{ id: "C1", check: "tests pass" }, { id: "C2", check: "public API unchanged" }],
    mustNot: ["no commits"],
  };
  const complete: Pick<DelegationReturn, "criteria" | "mustNot"> = {
    criteria: [
      { id: "C1", status: "met", evidence: "pytest tests/services/lean: 42 passed" },
      { id: "C2", status: "met", evidence: "diff touches only src/services/lean/verify.ts" },
    ],
    mustNot: [{ rule: "no commits", respected: true, evidence: "git log -1 unchanged (ecf4f9c)" }],
  };

  test("accepts a return with evidence for every criterion and rule", () => {
    expect(validateReturn(req, complete)).toEqual([]);
  });

  test("rejects a missing criterion", () => {
    expect(validateReturn(req, { ...complete, criteria: complete.criteria.slice(0, 1) })).toContain("C2: no result");
  });

  test("rejects empty evidence", () => {
    const criteria = [{ ...complete.criteria[0], evidence: "  " }, complete.criteria[1]];
    expect(validateReturn(req, { ...complete, criteria })).toContain("C1: evidence is empty");
  });

  test("rejects a criterion that was not requested", () => {
    const criteria = [...complete.criteria, { id: "C9", status: "met" as const, evidence: "x" }];
    expect(validateReturn(req, { ...complete, criteria })).toContain("C9: not requested");
  });

  test("rejects a missing must-not rule", () => {
    expect(validateReturn(req, { ...complete, mustNot: [] })).toContain('must-not "no commits": no result');
  });
});

describe("parseTernPane", () => {
  test("reads Tern's pane id", () => {
    expect(parseTernPane("549755813941")).toBe(549755813941);
  });

  test("refuses to run outside Tern", () => {
    expect(() => parseTernPane(undefined)).toThrow("Main is not running in a Tern pane");
    expect(() => parseTernPane("abc")).toThrow("Main is not running in a Tern pane");
  });
});
