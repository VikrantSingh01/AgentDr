import type { McpToolSnapshot, RunReport } from "./types.js";

export interface RedactionOptions {
  keys: string[];
  replacement?: string;
}

export function createRedactor(options?: RedactionOptions): (value: unknown) => unknown {
  const keys = new Set(options?.keys ?? []);
  const replacement = options?.replacement ?? "[REDACTED]";
  const sensitiveFlags = new Set(
    [...keys].flatMap((key) => [
      key.toLowerCase(),
      key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
    ])
  );

  const isSensitiveFlag = (value: unknown): boolean =>
    typeof value === "string" &&
    sensitiveFlags.has(value.replace(/^--?|^\//, "").toLowerCase());

  const redactString = (value: string): string => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(redact(parsed));
      }
    } catch {
      // Continue with key/value pattern redaction for diagnostic text.
    }

    let redacted = value;
    for (const key of keys) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      redacted = redacted.replace(
        new RegExp(`(["']?${escapedKey}["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, "gi"),
        `$1$2${replacement}$2`
      );
      redacted = redacted.replace(
        new RegExp(`(${escapedKey}\\s*[:=]\\s*)([^\\s,;]+)`, "gi"),
        `$1${replacement}`
      );
    }
    return redacted;
  };

  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        index > 0 && isSensitiveFlag(value[index - 1])
          ? replacement
          : redact(item)
      );
    }
    if (typeof value !== "object" || value === null) return value;

    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        keys.has(key) ? replacement : redact(nestedValue)
      ])
    );
  };

  return redact;
}

const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties"
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

function redactJsonSchema(
  value: unknown,
  keys: Set<string>,
  replacement: string,
  redactData: (value: unknown) => unknown,
  sensitiveProperty = false
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactJsonSchema(item, keys, replacement, redactData, sensitiveProperty)
    );
  }
  if (typeof value !== "object" || value === null) return redactData(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      if (
        SCHEMA_MAP_KEYWORDS.has(key) &&
        typeof nestedValue === "object" &&
        nestedValue !== null &&
        !Array.isArray(nestedValue)
      ) {
        return [
          key,
          Object.fromEntries(
            Object.entries(nestedValue).map(([mapKey, childSchema]) => [
              mapKey,
              redactJsonSchema(
                childSchema,
                keys,
                replacement,
                redactData,
                key === "properties" && keys.has(mapKey)
              )
            ])
          )
        ];
      }
      if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(nestedValue)) {
        return [
          key,
          nestedValue.map((childSchema) =>
            redactJsonSchema(
              childSchema,
              keys,
              replacement,
              redactData,
              sensitiveProperty
            )
          )
        ];
      }
      if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        if (!sensitiveProperty) return [key, redactData(nestedValue)];
        if (Array.isArray(nestedValue)) {
          return [key, nestedValue.map(() => replacement)];
        }
        return [key, replacement];
      }
      return [
        key,
        keys.has(key)
          ? replacement
          : redactJsonSchema(
              nestedValue,
              keys,
              replacement,
              redactData,
              sensitiveProperty
            )
      ];
    })
  );
}

function redactToolSnapshot(
  tool: McpToolSnapshot,
  options?: RedactionOptions
): McpToolSnapshot {
  const redactData = createRedactor(options);
  const keys = new Set(options?.keys ?? []);
  const replacement = options?.replacement ?? "[REDACTED]";
  const redacted = redactData(tool) as McpToolSnapshot;
  return {
    ...redacted,
    ...(tool.inputSchema
      ? {
          inputSchema: redactJsonSchema(
            tool.inputSchema,
            keys,
            replacement,
            redactData
          ) as Record<string, unknown>
        }
      : {}),
    ...(tool.outputSchema
      ? {
          outputSchema: redactJsonSchema(
            tool.outputSchema,
            keys,
            replacement,
            redactData
          ) as Record<string, unknown>
        }
      : {})
  };
}

export function redactRunReport(
  report: RunReport,
  options?: RedactionOptions
): RunReport {
  const redactData = createRedactor(options);
  const redacted = redactData(report) as RunReport;
  redacted.evidence = redacted.evidence.map((event, index) => {
    const rawEvent = report.evidence[index];
    if (rawEvent?.type !== "mcp_discovery" || event.type !== "mcp_discovery") {
      return event;
    }
    return {
      ...event,
      tools: rawEvent.tools.map((tool) => redactToolSnapshot(tool, options))
    };
  });
  return redacted;
}

export const RESERVED_REDACTION_KEYS = new Set([
  "type",
  "sequence",
  "timestamp",
  "tool",
  "callId",
  "arguments",
  "confirmed",
  "status",
  "source",
  "durationMs",
  "resultBytes",
  "isError",
  "state",
  "mode",
  "reason",
  "id",
  "severity",
  "message",
  "exitCode",
  "findings",
  "evidenceSequence",
  "evidence",
  "graph",
  "decision",
  "reportVersion",
  "runId",
  "scenarioId",
  "scenarioPath",
  "command",
  "name",
  "node",
  "startedAt",
  "serverCommand",
  "serverInfo",
  "tools",
  "capabilities",
  "capabilitySnapshotMatches",
  "toolSnapshotMatches",
  "driftedTools",
  "inputSchema",
  "outputSchema",
  "properties",
  "title",
  "description",
  "icons",
  "annotations",
  "execution",
  "_meta",
  "version",
  "listChanged",
  "subscribe",
  "$anchor",
  "$comment",
  "$defs",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$ref",
  "$schema",
  "$vocabulary",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "default",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "deprecated",
  "else",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
  "writeOnly"
]);