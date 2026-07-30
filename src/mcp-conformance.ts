import type { McpToolSnapshot } from "./types.js";

const ORDER_INSENSITIVE_ARRAY_KEYS = new Set(["enum", "required", "type"]);
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties"
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_SINGLE_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties"
]);

function canonicalizeData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeData);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalizeData(nestedValue)])
  );
}

function canonicalizeSchema(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalizeData);
    return ORDER_INSENSITIVE_ARRAY_KEYS.has(parentKey ?? "")
      ? items.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
      : items;
  }
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => {
        if (
          SCHEMA_MAP_KEYS.has(key) &&
          typeof nestedValue === "object" &&
          nestedValue !== null &&
          !Array.isArray(nestedValue)
        ) {
          return [
            key,
            Object.fromEntries(
              Object.entries(nestedValue)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([mapKey, schema]) => [mapKey, canonicalizeSchema(schema)])
            )
          ];
        }
        if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(nestedValue)) {
          return [key, nestedValue.map((schema) => canonicalizeSchema(schema))];
        }
        if (SCHEMA_SINGLE_KEYS.has(key)) {
          return [key, canonicalizeSchema(nestedValue)];
        }
        return [
          key,
          ORDER_INSENSITIVE_ARRAY_KEYS.has(key)
            ? canonicalizeSchema(nestedValue, key)
            : canonicalizeData(nestedValue)
        ];
      })
  );
}

export function contractsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeData(left)) === JSON.stringify(canonicalizeData(right));
}

function toolContractsEqual(left: McpToolSnapshot, right: McpToolSnapshot): boolean {
  const canonicalizeTool = (tool: McpToolSnapshot) =>
    Object.fromEntries(
      Object.entries(tool)
        .filter(([, value]) => value !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, value]) => [
          key,
          key === "inputSchema" || key === "outputSchema"
            ? canonicalizeSchema(value)
            : canonicalizeData(value)
        ])
    );
  return JSON.stringify(canonicalizeTool(left)) === JSON.stringify(canonicalizeTool(right));
}

export function compareToolSnapshots(
  expected: McpToolSnapshot[],
  actual: McpToolSnapshot[]
): { matches: boolean; driftedTools: string[] } {
  const expectedCounts = countToolNames(expected);
  const actualCounts = countToolNames(actual);
  const expectedByName = new Map(expected.map((tool) => [tool.name, tool]));
  const actualByName = new Map(actual.map((tool) => [tool.name, tool]));
  const names = [...new Set([...expectedByName.keys(), ...actualByName.keys()])].sort();
  const driftedTools = names.filter(
    (name) =>
      expectedCounts.get(name) !== 1 ||
      actualCounts.get(name) !== 1 ||
      !expectedByName.has(name) ||
      !actualByName.has(name) ||
      !toolContractsEqual(expectedByName.get(name)!, actualByName.get(name)!)
  );
  return { matches: driftedTools.length === 0, driftedTools };
}

function countToolNames(tools: McpToolSnapshot[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  return counts;
}

export function normalizeMcpTool(tool: {
  name: string;
  title?: string;
  description?: string;
  icons?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
  _meta?: unknown;
}): McpToolSnapshot {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(Array.isArray(tool.icons)
      ? { icons: tool.icons as Array<Record<string, unknown>> }
      : {}),
    ...(typeof tool.inputSchema === "object" && tool.inputSchema !== null
      ? { inputSchema: tool.inputSchema as Record<string, unknown> }
      : {}),
    ...(typeof tool.outputSchema === "object" && tool.outputSchema !== null
      ? { outputSchema: tool.outputSchema as Record<string, unknown> }
      : {}),
    ...(typeof tool.annotations === "object" && tool.annotations !== null
      ? { annotations: tool.annotations as Record<string, unknown> }
      : {}),
    ...(typeof tool.execution === "object" && tool.execution !== null
      ? { execution: tool.execution as Record<string, unknown> }
      : {}),
    ...(typeof tool._meta === "object" && tool._meta !== null
      ? { _meta: tool._meta as Record<string, unknown> }
      : {})
  };
}