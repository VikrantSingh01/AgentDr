export const scenarioSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agentdoctor.dev/schema/scenario-0.1.json",
  $defs: {
    fileReference: {
      type: "object",
      additionalProperties: false,
      required: ["$file"],
      properties: {
        $file: { type: "string", minLength: 1 }
      }
    },
    mcpToolSnapshot: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        title: { type: "string" },
        description: { type: "string" },
        icons: {
          type: "array",
          items: { type: "object" }
        },
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        annotations: { type: "object" },
        execution: { type: "object" },
        _meta: { type: "object" }
      }
    }
  },
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "input", "expect"],
  properties: {
    schemaVersion: { const: "0.1" },
    id: { type: "string", minLength: 1, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
    input: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", minLength: 1 },
        data: {}
      }
    },
    fixtures: {
      type: "object",
      additionalProperties: {}
    },
    adapter: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 }
        }
      }
    },
    mcp: {
      type: "object",
      additionalProperties: false,
      required: ["server"],
      properties: {
        server: {
          type: "object",
          additionalProperties: false,
          required: ["command"],
          properties: {
            command: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 }
            }
          }
        },
        capabilitySnapshot: { type: "object" },
        toolSnapshot: {
          oneOf: [
            {
              type: "array",
              items: { $ref: "#/$defs/mcpToolSnapshot" }
            },
            { $ref: "#/$defs/fileReference" }
          ]
        },
        startupTimeoutMs: { type: "integer", minimum: 1 },
        requestTimeoutMs: { type: "integer", minimum: 1 },
        maxResponseBytes: { type: "integer", minimum: 1 },
        maxToolDurationMs: { type: "integer", minimum: 1 },
        redaction: {
          type: "object",
          additionalProperties: false,
          required: ["keys"],
          properties: {
            keys: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", minLength: 1 }
            },
            replacement: { type: "string" }
          }
        }
      }
    },
    expect: {
      type: "object",
      additionalProperties: false,
      properties: {
        tools: {
          type: "object",
          additionalProperties: false,
          properties: {
            required: { type: "array", uniqueItems: true, items: { type: "string" } },
            forbidden: { type: "array", uniqueItems: true, items: { type: "string" } },
            order: { type: "array", items: { type: "string" } },
            maxCalls: { type: "integer", minimum: 0 },
            arguments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["tool"],
                properties: {
                  tool: { type: "string", minLength: 1 },
                  match: { type: "object" },
                  schema: { type: "object" }
                }
              }
            }
          }
        },
        confirmation: {
          type: "object",
          additionalProperties: false,
          required: ["requiredBefore"],
          properties: {
            requiredBefore: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", minLength: 1 }
            }
          }
        },
        outcome: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: {
            status: { type: "string", minLength: 1 },
            match: {},
            schema: { type: "object" }
          }
        }
      }
    },
    performance: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDurationMs: { type: "integer", minimum: 1 }
      }
    }
  }
} as const;