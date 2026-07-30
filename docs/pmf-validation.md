# MCP Wedge PMF Validation

## Current Evidence

Agent Doctor has technical feasibility evidence, not product-market fit. The
real MCP demo proves that one local contract can observe discovery, tool calls,
mutations, latency, response size, schema drift, errors, and redaction. PMF
requires external teams to retain the check in normal pull-request work.

## Beachhead Hypothesis

The first high-intent user is a TypeScript team shipping an MCP-connected agent
that can mutate calendars, repositories, tickets, cloud resources, or business
records. The team already uses GitHub pull requests and has experienced a tool
selection, argument, confirmation, or schema regression.

The narrow promise is:

> Record the expected MCP action contract once, then block unsafe tool and
> protocol regressions in CI with evidence that reproduces locally.

## Alternatives To Beat

- framework-specific trace inspection;
- hand-written integration tests;
- prompt snapshots and exact-text assertions;
- hosted evaluation suites that require trace upload;
- manually running MCP Inspector after changes.

Agent Doctor must be materially faster to author and diagnose than those
alternatives. Portability alone is not sufficient value.

## Public Problem Signals

These issues support the problem hypothesis but do not prove willingness to pay:

- [apiome #4532](https://github.com/apiome/apiome/issues/4532) requests a
	versioned MCP tool-schema regression corpus, deterministic golden generation,
	schema-validity checks, and CI failure on drift. This directly supports the
	snapshot and reviewable-diff wedge.
- [Claude Code #79983](https://github.com/anthropics/claude-code/issues/79983)
	reports a mutating Gmail tool remaining blocked after repeated approval, with
	manual email creation as the workaround. This supports explicit,
	evidence-backed confirmation contracts.
- [microsoft/mcp #2755](https://github.com/microsoft/mcp/issues/2755) describes
	expensive live-test setup and test output that is too noisy to diagnose. This
	supports scoped scenarios and concise evidence locations rather than large
	undifferentiated JSON logs.
- [ContextForge reverse proxy #2](https://github.com/contextforge-org/mcp-reverse-proxy/issues/2)
	proposes a companion MCP server and integration CI because unit tests do not
	exercise the proxy end to end. This supports shipping reusable conformance
	servers and scenarios.

The recurring job is narrower than "agent observability": make MCP contract
changes and approval failures reproducible, reviewable, and actionable in CI.
Interviews must still establish frequency, ownership, retention, and budget.

## Problem Interview

Ask about the last incident, not desired features:

1. What agent or MCP change caused the last pre-release or production failure?
2. Which tool was called, with what arguments, and what should have happened?
3. How was the failure discovered and reproduced?
4. How long did diagnosis take, and who participated?
5. What test existed before the incident? Why did it miss the failure?
6. Would a deterministic PR check have blocked a legitimate change?
7. What data may not leave the developer machine or CI runner?
8. Who owns the quality gate and who can approve a blocking policy?

Do not demo Agent Doctor until the incident timeline and current workaround are
understood.

## Two-Week Pilot

1. Select one mutating MCP workflow and one recent real failure.
2. Measure current scenario-authoring and diagnosis time.
3. Add Agent Doctor as a non-blocking PR check for ten pull requests.
4. Seed one known regression; record false positives and unsupported evidence.
5. Let the partner maintain the scenario without project-team edits.
6. Ask the team to keep, remove, or pay for the check at pilot end.

## Scorecard

| Signal | Continue threshold |
|---|---:|
| Problem interviews | 6 of 10 report recurring pre-release action failures |
| Scenario expressiveness | 4 real failures represented without framework forks |
| Initial authoring | Median under 15 minutes |
| Independent onboarding | End-to-end under 30 minutes |
| Pilot precision | No critical false block across 10 PRs |
| Unseeded value | At least one meaningful real regression caught |
| Retention | 2 teams keep the check after the pilot |
| Commercial intent | 1 team names budget or signs a paid-design-partner letter |

## Decision

- **Proceed:** retention plus an unseeded catch, with acceptable maintenance.
- **Revise:** pain is real but scenarios are too expensive or evidence is weak.
- **Stop:** teams prefer existing tests and remove the check after the demo.

No download, star, seeded test, or internal benchmark should be reported as PMF.