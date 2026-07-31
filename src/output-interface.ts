import type { Scenario } from "./types.js";

export interface OutputInterface {
  schema?: Record<string, unknown>;
  /**
   * Paths the contract reads out of the final report. Some come from the schema,
   * but obligations, budgets and `$fromOutcome` references read paths the schema
   * never mentions, and those are the ones an agent has no way to discover.
   */
  readPaths: string[];
  /** Read paths the schema does not require. These are the silent obligations. */
  undeclared: string[];
}

function collectFromOutcomeReferences(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFromOutcomeReferences(item, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.$fromOutcome === "string") {
    found.add(record.$fromOutcome);
    return;
  }
  for (const nested of Object.values(record)) collectFromOutcomeReferences(nested, found);
}

function schemaRequires(schema: Record<string, unknown> | undefined, path: string): boolean {
  if (!schema) return false;
  const [head, ...rest] = path.split(".");
  const required = schema.required;
  if (!Array.isArray(required) || !required.includes(head)) return false;
  if (rest.length === 0) return true;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const child = properties?.[head!];
  if (typeof child !== "object" || child === null) return false;
  return schemaRequires(child as Record<string, unknown>, rest.join("."));
}

export function collectOutputInterface(scenario: Scenario): OutputInterface {
  const schema = scenario.expect.outcome?.schema as Record<string, unknown> | undefined;
  const paths = new Set<string>();

  for (const entry of scenario.expect.tools?.required ?? []) {
    if (typeof entry !== "string") paths.add(entry.when.outcomePath);
  }
  for (const budget of scenario.expect.tools?.budgets ?? []) {
    if (budget.callsMatchOutcome !== undefined) paths.add(budget.callsMatchOutcome);
  }
  for (const argument of scenario.expect.tools?.arguments ?? []) {
    collectFromOutcomeReferences(argument.match, paths);
  }
  for (const key of Object.keys(scenario.expect.outcome?.match ?? {})) paths.add(key);

  const readPaths = [...paths].sort();
  return {
    schema,
    readPaths,
    undeclared: readPaths.filter((path) => !schemaRequires(schema, path))
  };
}

export function renderOutputInterface(scenario: Scenario): string {
  const { schema, readPaths, undeclared } = collectOutputInterface(scenario);
  const lines: string[] = [];

  lines.push(`# Required final output for ${scenario.id}`);
  lines.push("");

  if (!schema && readPaths.length === 0) {
    lines.push("This contract makes no assertion about the final output.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("Return a single JSON object as the final output.");
  lines.push("");

  if (schema) {
    lines.push("It must satisfy this JSON Schema:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(schema, undefined, 2));
    lines.push("```");
    lines.push("");
  }

  if (readPaths.length > 0) {
    lines.push("These paths are read by the contract and must be present:");
    lines.push("");
    for (const path of readPaths) lines.push(`- \`${path}\``);
    lines.push("");
  }

  if (undeclared.length > 0) {
    lines.push(
      `The schema does not require ${undeclared
        .map((path) => `\`${path}\``)
        .join(", ")}, so an agent reading the schema alone would not know to report ${
        undeclared.length === 1 ? "it" : "them"
      }.`
    );
    lines.push("");
  }

  lines.push("Key names are part of the contract. Reporting the right information");
  lines.push("under different names is a failure.");
  return `${lines.join("\n")}\n`;
}
