# Contributing

Agent Doctor welcomes focused fixes, deterministic evaluators, protocol tests,
and adapters backed by real use cases.

## Development

Requirements: Node.js 20, 22, or 24 and npm.

```bash
npm ci
npm run check
```

Changes to the scenario contract must update `src/scenario-schema.ts`. The build
generates `schema/scenario-0.1.json`; do not edit the generated file directly.

The supported programmatic surface lives in `src/index.ts`. Changes to exported
symbols or custom backend lifecycle behavior must include focused API and packed
package tests. Keep transport extensions behind `ToolBackend`; deterministic
findings belong in the scenario evaluator and require a real contract use case.

Pull requests should include a focused test and avoid exposing prompts, fixture
content, credentials, or production traces. Observable behavior belongs in the
evidence model; hidden model reasoning does not.