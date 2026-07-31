# Agent Doctor repository instructions

- MCP integration uses the official TypeScript SDK v2 packages.
- Client documentation: https://ts.sdk.modelcontextprotocol.io/v2/clients/
- Server documentation: https://ts.sdk.modelcontextprotocol.io/v2/servers/
- Protocol specification: https://modelcontextprotocol.io/specification/latest
- Keep stdio server logs on stderr; stdout is reserved for MCP JSON-RPC.
- Prefer deterministic structural checks and observable evidence over model judges.

## Git

- Never add a `Co-authored-by: Copilot` trailer to commits. The history of this
  repository was deliberately scrubbed of it and must stay that way.
- Normalise CRLF to LF before `git add` on agent-written files; `git add` fails
  otherwise.