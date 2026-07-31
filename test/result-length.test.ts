import { describe, expect, it } from "vitest";

import { resolveCandidates, validateReference } from "../src/result-reference.js";
import type { EvidenceEvent } from "../src/types.js";

function evidence(result: unknown): EvidenceEvent[] {
  return [
    {
      type: "tool_call",
      sequence: 1,
      callId: "c1",
      tool: "ado.query_untriaged_bugs",
      arguments: { areaPath: "Team\\Area" }
    },
    {
      type: "tool_result",
      sequence: 2,
      callId: "c1",
      tool: "ado.query_untriaged_bugs",
      result
    }
  ] as EvidenceEvent[];
}

describe("$fromResult length", () => {
  it("resolves to the number of elements at the path", () => {
    const candidates = resolveCandidates(
      { tool: "ado.query_untriaged_bugs", path: "bugs", length: true },
      evidence({ bugs: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    );
    expect(candidates).toEqual([3]);
  });

  it("resolves an empty collection to zero rather than leaving it unresolved", () => {
    const candidates = resolveCandidates(
      { tool: "ado.query_untriaged_bugs", path: "bugs", length: true },
      evidence({ bugs: [] })
    );
    expect(candidates).toEqual([0]);
  });

  // Counting a non-collection would produce a number that means nothing: object
  // key counts and string lengths are not workload measures. Leaving it
  // unresolved makes the contract report rather than pass for the wrong reason.
  it("leaves a non-collection unresolved instead of counting keys or characters", () => {
    expect(
      resolveCandidates(
        { tool: "ado.query_untriaged_bugs", path: "bugs", length: true },
        evidence({ bugs: { a: 1, b: 2 } })
      )
    ).toEqual([]);
    expect(
      resolveCandidates(
        { tool: "ado.query_untriaged_bugs", path: "bugs", length: true },
        evidence({ bugs: "three" })
      )
    ).toEqual([]);
  });

  it("still resolves the value itself when length is absent", () => {
    const candidates = resolveCandidates(
      { tool: "ado.query_untriaged_bugs", path: "bugs" },
      evidence({ bugs: [{ id: 1 }] })
    );
    expect(candidates).toEqual([[{ id: 1 }]]);
  });

  it("counts only the elements a find selector admits", () => {
    const candidates = resolveCandidates(
      {
        tool: "ado.query_untriaged_bugs",
        path: "bugs",
        find: { id: 2 },
        length: true
      },
      evidence({ bugs: [{ id: 1 }, { id: 2 }] })
    );
    expect(candidates).toEqual([]);
  });

  it("accepts length as a boolean", () => {
    expect(
      validateReference({ tool: "t", path: "p", length: true })
    ).toEqual([]);
  });

  it("rejects a non-boolean length", () => {
    expect(validateReference({ tool: "t", path: "p", length: "yes" })).toContain(
      "$fromResult length must be a boolean"
    );
  });

  it("rejects length combined with a declared sequence", () => {
    expect(
      validateReference({
        tool: "t",
        path: "p",
        length: true,
        sequence: ["a", "b"]
      })
    ).toContain(
      "$fromResult cannot combine length with sequence; a count has no position in a declared sequence"
    );
  });
});
