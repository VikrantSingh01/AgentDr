import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { RESERVED_REDACTION_KEYS } from "./redaction.js";
import { lintScenario } from "./scenario-linter.js";
import { scenarioSchema } from "./scenario-schema.js";
import type {
  FixtureCase,
  McpToolSnapshot,
  ResolvedFixtures,
  Scenario
} from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateScenario = ajv.compile<Scenario>(scenarioSchema);
const validateMcpToolSnapshot = ajv.compile<McpToolSnapshot[]>({
  type: "array",
  items: scenarioSchema.$defs.mcpToolSnapshot
});

function parseDocument(path: string, content: string): unknown {
  if (extname(path).toLowerCase() === ".json") {
    return JSON.parse(content) as unknown;
  }

  return parse(content) as unknown;
}

async function resolveFixtures(
  scenario: Scenario,
  scenarioPath: string
): Promise<ResolvedFixtures> {
  const fixtures: ResolvedFixtures = {};

  const resolveResult = async (tool: string, value: unknown): Promise<unknown> => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("$file" in value) ||
      typeof value.$file !== "string"
    ) {
      return value;
    }

    if (Object.keys(value).length !== 1) {
      throw new Error(`Fixture reference for ${tool} may only contain $file`);
    }

    const fixturePath = resolve(dirname(scenarioPath), value.$file);
    let content: string;
    try {
      content = await readFile(fixturePath, "utf8");
    } catch {
      throw new Error(`Fixture for ${tool} was not found: ${fixturePath}`);
    }
    return parseDocument(fixturePath, content);
  };

  for (const [tool, fixture] of Object.entries(scenario.fixtures ?? {})) {
    if (
      typeof fixture === "object" &&
      fixture !== null &&
      "$cases" in fixture &&
      Array.isArray(fixture.$cases)
    ) {
      const cases: FixtureCase[] = [];
      for (const fixtureCase of fixture.$cases) {
        const candidate = fixtureCase as FixtureCase;
        cases.push({
          ...(candidate.callIndex !== undefined
            ? { callIndex: candidate.callIndex }
            : {}),
          ...(candidate.arguments !== undefined
            ? { arguments: candidate.arguments }
            : {}),
          result: await resolveResult(tool, candidate.result)
        });
      }
      fixtures[tool] = { cases };
      continue;
    }

    fixtures[tool] = {
      cases: [{ result: await resolveResult(tool, fixture) }]
    };
  }

  return fixtures;
}

async function resolveMcpToolSnapshot(
  scenario: Scenario,
  scenarioPath: string
): Promise<void> {
  const snapshot = scenario.mcp?.toolSnapshot;
  if (!snapshot || Array.isArray(snapshot)) return;

  const snapshotPath = resolve(dirname(scenarioPath), snapshot.$file);
  let document: unknown;
  try {
    document = parseDocument(snapshotPath, await readFile(snapshotPath, "utf8"));
  } catch {
    throw new Error(`MCP tool snapshot was not found or invalid: ${snapshotPath}`);
  }
  if (!validateMcpToolSnapshot(document)) {
    const errors = (validateMcpToolSnapshot.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid MCP tool snapshot: ${errors}`);
  }

  scenario.mcp!.toolSnapshot = document;
}

export async function loadScenario(path: string): Promise<{
  scenario: Scenario;
  fixtures: Record<string, unknown>;
  resolvedFixtures: ResolvedFixtures;
}> {
  const scenarioPath = resolve(path);
  const document: unknown = parseDocument(
    scenarioPath,
    await readFile(scenarioPath, "utf8")
  );

  if (!validateScenario(document)) {
    const errors = (validateScenario.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid scenario: ${errors}`);
  }

  const scenario = document as Scenario;
  for (const key of scenario.mcp?.redaction?.keys ?? []) {
    if (RESERVED_REDACTION_KEYS.has(key)) {
      throw new Error(
        `Invalid redaction key ${key}: structural report fields cannot be redacted`
      );
    }
  }
  for (const argumentExpectation of scenario.expect.tools?.arguments ?? []) {
    if (!argumentExpectation.schema) continue;
    try {
      ajv.compile(argumentExpectation.schema);
    } catch (error) {
      throw new Error(
        `Invalid argument schema for ${argumentExpectation.tool}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (scenario.expect.outcome?.schema) {
    try {
      ajv.compile(scenario.expect.outcome.schema);
    } catch (error) {
      throw new Error(
        `Invalid outcome schema: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  await resolveMcpToolSnapshot(scenario, scenarioPath);
  const resolvedFixtures = await resolveFixtures(scenario, scenarioPath);
  const lintErrors = lintScenario(scenario, resolvedFixtures);
  if (lintErrors.length > 0) {
    throw new Error(`Invalid scenario semantics: ${lintErrors.join("; ")}`);
  }

  return {
    scenario,
    fixtures: Object.fromEntries(
      Object.entries(resolvedFixtures).map(([tool, fixture]) => [
        tool,
        fixture.cases.length === 1 &&
        fixture.cases[0].callIndex === undefined &&
        fixture.cases[0].arguments === undefined
          ? fixture.cases[0].result
          : fixture
      ])
    ),
    resolvedFixtures
  };
}