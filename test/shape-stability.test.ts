import { describe, expect, it } from "vitest";

import {
  collectShape,
  compareShapes,
  renderShapeReport,
  shapeOfReport,
  type RunShape
} from "../src/shape-stability.js";
import type { RunReport } from "../src/types.js";

function shape(run: number, paths: string[], reported = true): RunShape {
  return { run, paths, reported };
}

describe("collectShape", () => {
  it("emits every container and leaf path", () => {
    expect(collectShape({ areaPath: "x", rollout: { ring: "ring1" } })).toEqual([
      "areaPath",
      "rollout",
      "rollout.ring"
    ]);
  });

  // An agent that handles three records in one run and two in the next is doing
  // its job. Indexing the paths would report that as instability, which is the
  // false positive this check exists to avoid.
  it("collapses array indices so a different record count is not a divergence", () => {
    const two = collectShape({ routed: [{ id: 1 }, { id: 2 }] });
    const three = collectShape({ routed: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(two).toEqual(three);
    expect(two).toEqual(["routed", "routed[].id"]);
  });

  it("collapses a scalar collection to its container", () => {
    expect(collectShape({ tags: ["a", "b"] })).toEqual(["tags"]);
  });

  it("agrees with a populated collection on the container and differs only on leaves", () => {
    expect(collectShape({ routed: [] })).toEqual(["routed"]);
    expect(collectShape({ routed: [{ id: 1 }] })).toEqual(["routed", "routed[].id"]);
  });

  it("treats null as a leaf rather than recursing into it", () => {
    expect(collectShape({ owner: null })).toEqual(["owner"]);
  });
});

describe("compareShapes", () => {
  it("reports no divergence when every run agrees", () => {
    expect(
      compareShapes([shape(1, ["a", "b"]), shape(2, ["a", "b"]), shape(3, ["a", "b"])])
    ).toEqual([]);
  });

  // This is the Copilot case: the same information reported under a different
  // key on a different run.
  it("names the paths that appear in some runs and not others", () => {
    const divergences = compareShapes([
      shape(1, ["escalated", "escalatedBugIds"]),
      shape(2, ["escalated", "escalated.bugIds"])
    ]);
    expect(divergences).toEqual([
      { path: "escalated.bugIds", presentIn: [2], absentIn: [1] },
      { path: "escalatedBugIds", presentIn: [1], absentIn: [2] }
    ]);
  });

  // A crashed run has no shape. Treating it as an empty one would make every
  // path look unstable and bury the real failure under noise it caused.
  it("excludes a run that never reported rather than treating it as empty", () => {
    expect(
      compareShapes([shape(1, ["a"]), shape(2, ["a"]), shape(3, [], false)])
    ).toEqual([]);
  });

  it("does not measure stability when fewer than two runs reported", () => {
    expect(compareShapes([shape(1, ["a"]), shape(2, [], false)])).toEqual([]);
  });
});

describe("shapeOfReport", () => {
  it("reads the final event's output", () => {
    const report = {
      evidence: [
        { type: "tool_call", sequence: 1, callId: "c1", tool: "t", arguments: {} },
        { type: "final", sequence: 2, status: "completed", output: { reviewed: 3 } }
      ]
    } as unknown as RunReport;
    expect(shapeOfReport(report, 1)).toEqual({
      run: 1,
      reported: true,
      paths: ["reviewed"]
    });
  });

  it("marks a report with no final event as not reported", () => {
    const report = { evidence: [] } as unknown as RunReport;
    expect(shapeOfReport(report, 2).reported).toBe(false);
  });
});

describe("renderShapeReport", () => {
  it("states stability and the path count when every run agrees", () => {
    const output = renderShapeReport([shape(1, ["a", "b"]), shape(2, ["a", "b"])], []);
    expect(output).toContain("Stable across 2 runs");
    expect(output).toContain("2 paths");
  });

  it("names each divergent path and the runs it was present and absent in", () => {
    const shapes = [shape(1, ["a"]), shape(2, ["b"])];
    const output = renderShapeReport(shapes, compareShapes(shapes));
    expect(output).toContain("Unstable across 2 runs");
    expect(output).toContain("present in run(s) 1, absent in run(s) 2");
    expect(output).toContain("present in run(s) 2, absent in run(s) 1");
  });

  it("says stability was not measured rather than claiming it held", () => {
    const output = renderShapeReport([shape(1, ["a"]), shape(2, [], false)], []);
    expect(output).toContain("shape stability was not measured");
    expect(output).not.toContain("Stable across");
  });
});
