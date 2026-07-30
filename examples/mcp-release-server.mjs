import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const regression = process.argv
  .find((argument) => argument.startsWith("--regression="))
  ?.slice("--regression=".length);

const releaseOutputSchema = z.object({
  project: z.string(),
  status: z.enum(["ready", "at-risk", "blocked"]),
  releaseDate: z.string(),
  internal: z.object({
    accessToken: z.string(),
    ownerEmail: z.string()
  }),
  history: z.string().optional()
});

function structured(output) {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output
  };
}

function createServer() {
  const server = new McpServer({
    name: "agentdoctor-release-demo",
    version: "1.0.0"
  });

  server.registerTool(
    "project.get_release_status",
    {
      description: "Read the current release status for one project",
      inputSchema: z.object({
        project:
          regression === "schema-drift"
            ? z.string().min(2).describe("Project name")
            : z.string().min(1).describe("Project name")
      }),
      outputSchema: releaseOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ project }) => {
      if (regression === "slow-response") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      }
      const output = {
        project,
        status: "at-risk",
        releaseDate: "2026-08-14",
        internal: {
          accessToken: "demo-token-must-not-enter-evidence",
          ownerEmail: "release-owner@contoso.example"
        },
        ...(regression === "oversized-response"
          ? { history: "release-history:".padEnd(6000, "x") }
          : {})
      };
      return structured(output);
    }
  );

  if (regression !== "missing-tool") {
    server.registerTool(
      "bugs.list_blockers",
      {
        description: "List unresolved release blockers for one project",
        inputSchema: z.object({
          project: z.string().min(1),
          state: z.literal("open")
        }),
        outputSchema: z.object({
          project: z.string(),
          open: z.array(z.object({ id: z.string(), title: z.string() }))
        }),
        annotations: { readOnlyHint: true }
      },
      async ({ project }) => {
        if (regression === "tool-error") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  message: "Issue tracker unavailable",
                  accessToken: "tool-error-secret"
                })
              }
            ],
            isError: true
          };
        }
        return structured({
          project,
          open: [
            {
              id: "BUG-42",
              title: "Token refresh fails during deployment"
            }
          ]
        });
      }
    );
  }

  server.registerTool(
    "calendar.check_availability",
    {
      description: "Find available review meeting times",
      inputSchema: z.object({
        durationMinutes: z.number().int().min(15).max(120)
      }),
      outputSchema: z.object({
        slots: z.array(z.string())
      }),
      annotations: { readOnlyHint: true }
    },
    async () =>
      structured({
        slots: ["2026-07-31T15:00:00Z", "2026-07-31T16:00:00Z"]
      })
  );

  server.registerTool(
    "calendar.create_event",
    {
      title: "Create release review event",
      description: "Create a confirmed calendar event",
      icons: [
        {
          src: "https://example.com/agentdoctor/calendar.png",
          mimeType: "image/png",
          sizes: ["48x48"]
        }
      ],
      inputSchema: z.object({
        title: z.string().min(1),
        startsAt: z.string(),
        durationMinutes: z.number().int().min(15).max(120)
      }),
      outputSchema: z.object({
        eventId: z.string(),
        status: z.literal("created")
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      },
      _meta: { "com.agentdoctor/risk": "mutation" }
    },
    async () => structured({ eventId: "evt-mcp-demo", status: "created" })
  );

  return server;
}

serveStdio(createServer, {
  onerror: (error) => console.error(`MCP server error: ${error.message}`)
});
console.error(
  `AgentDr release MCP server running (${regression ?? "safe"})${
    regression === "missing-tool" ? " accessToken=protocol-error-secret" : ""
  }`
);