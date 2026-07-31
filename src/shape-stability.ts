import type { EvidenceEvent, RunReport } from "./types.js";

/**
 * Three runs of the same agent on the same prompt produced three different
 * report shapes. Nothing in a per-run contract can see that: each run's report
 * is internally consistent, and the contract judges one run at a time. The
 * instability is only visible by comparing runs, which is why it is measured
 * here rather than expressed as an expectation.
 */
export interface RunShape {
  run: number;
  paths: string[];
  reported: boolean;
}

export interface ShapeDivergence {
  path: string;
  presentIn: number[];
  absentIn: number[];
}

/**
 * Array indices are collapsed to a single `[]` segment, and an element never
 * emits a path of its own. Without that, an agent that legitimately handles
 * three records in one run and two in the next would be reported as unstable
 * for doing its job, which is the false positive this project prices as heavily
 * as a miss.
 *
 * Every object node emits its own path before its children, so a nested
 * structure and a bare scalar are distinguishable and the divergence report can
 * be specific about which level actually changed.
 */
export function collectShape(output: unknown): string[] {
  const paths = new Set<string>();

  const walk = (value: unknown, prefix: string, emit: boolean): void => {
    if (prefix !== "" && emit) paths.add(prefix);
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry, `${prefix}[]`, false);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, prefix === "" ? key : `${prefix}.${key}`, true);
      }
    }
  };

  walk(output, "", true);
  return [...paths].sort();
}

function finalOutput(evidence: EvidenceEvent[]): { found: boolean; output: unknown } {
  const final = [...evidence].reverse().find((event) => event.type === "final");
  return final ? { found: true, output: final.output } : { found: false, output: undefined };
}

export function shapeOfReport(report: RunReport, run: number): RunShape {
  const final = finalOutput(report.evidence ?? []);
  return {
    run,
    reported: final.found,
    paths: final.found ? collectShape(final.output) : []
  };
}

/**
 * A run that never reported is excluded rather than treated as having reported
 * nothing. Counting a crash as an empty shape would make every other path look
 * unstable and bury the real failure under noise it caused.
 */
export function compareShapes(shapes: RunShape[]): ShapeDivergence[] {
  const reporting = shapes.filter((shape) => shape.reported);
  if (reporting.length < 2) return [];

  const union = new Set<string>();
  for (const shape of reporting) {
    for (const path of shape.paths) union.add(path);
  }

  const divergences: ShapeDivergence[] = [];
  for (const path of [...union].sort()) {
    const presentIn = reporting.filter((s) => s.paths.includes(path)).map((s) => s.run);
    if (presentIn.length === reporting.length) continue;
    divergences.push({
      path,
      presentIn,
      absentIn: reporting.filter((s) => !s.paths.includes(path)).map((s) => s.run)
    });
  }
  return divergences;
}

export function renderShapeReport(
  shapes: RunShape[],
  divergences: ShapeDivergence[]
): string {
  const reporting = shapes.filter((shape) => shape.reported);
  const lines: string[] = ["", "Output shape across runs"];

  const skipped = shapes.filter((shape) => !shape.reported);
  if (skipped.length > 0) {
    lines.push(
      `  ${skipped.length} of ${shapes.length} run(s) produced no final report and were excluded: ${skipped
        .map((shape) => `run ${shape.run}`)
        .join(", ")}`
    );
  }

  if (reporting.length < 2) {
    lines.push("  Fewer than two runs reported, so shape stability was not measured.");
    return `${lines.join("\n")}\n`;
  }

  if (divergences.length === 0) {
    lines.push(
      `  Stable across ${reporting.length} runs: ${reporting[0].paths.length} paths, identical in every run.`
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `  Unstable across ${reporting.length} runs: ${divergences.length} path(s) appeared in some runs and not others.`
  );
  for (const divergence of divergences) {
    lines.push(
      `    ${divergence.path} — present in run(s) ${divergence.presentIn.join(", ")}, absent in run(s) ${divergence.absentIn.join(", ")}`
    );
  }
  lines.push(
    "  An agent whose report shape depends on the run cannot be held to an output contract."
  );
  return `${lines.join("\n")}\n`;
}
