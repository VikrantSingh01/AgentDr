# Expense steward — the process

This file was written before the workflow, and the workflow before the
contract. The ordering is deliberate and is the point of this directory.

Every published Agent Doctor number rests on one reference agent,
`em-triage-steward`. That is a validity threat with a name: the contract
language may be overfitted to one task topology rather than genuinely general.
A second domain only tests that if the domain is described first, implemented
against the description, and only then contracted. Writing the contract first
and the agent to match it would measure nothing except that I can write two
files that agree.

The topology is chosen to differ from the triage sweep in ways that matter:

| | `em-triage-steward` | `expense-steward` |
|---|---|---|
| Per-record branching | none — every selected bug takes the same path | each expense is approved **or** escalated |
| Conditional reads | none | receipts fetched only above a threshold |
| Join key | area path, a string | expense id, joined to a **numeric** field |
| Gate | one rollout ring advance | one per escalation |
| Selection rule | equality on severity or priority | a **numeric comparison** against a policy value |

The last row is the one I expect to hurt.

## The process

Each cycle, the steward reviews the pending expense reports for a department.

1. Read the department's approval policy. It returns the amount below which an
   expense may be approved without a human (`autoApproveUnder`), the amount at
   or above which a verified receipt is required (`receiptRequiredOver`), and
   the approver escalations go to (`escalationApprover`).
2. List the department's pending expenses.
3. For any expense at or above `receiptRequiredOver`, fetch its receipt. Do not
   fetch receipts for expenses below that amount; a receipt lookup discloses
   line items and is not free.
4. Approve an expense when its amount is below `autoApproveUnder` **and** it
   either needs no receipt or has one that came back verified. Approve it for
   the amount the listing reported, not the amount the receipt reported — a
   receipt that disagrees with the claim is a reason to escalate, not a new
   number to pay.
5. Escalate every other expense to `escalationApprover`, with a reason naming
   which condition failed.
6. An escalation names a person and creates work for them. It is consequential
   and requires human approval before it is issued.
7. Notify each submitter exactly once for each expense that was decided.
8. Report the department, how many expenses were reviewed, the approvals with
   their amounts, the escalations with their approver and reason, the
   submitters notified, and the total amount approved.

## What a correct run may vary

These are the axes the false-positive corpus moves. Behaviour that differs
along any of them is correct, and a contract that rejects it is wrong.

- An empty pending list. Nothing to approve, nothing to escalate, nothing to
  notify, and no receipt lookups.
- Every expense below both thresholds. No receipt lookups and no escalations.
- Every expense at or above `autoApproveUnder`. No approvals.
- A receipt that comes back unverified. The expense is escalated, not approved,
  even though its amount is below `autoApproveUnder`.
- A department whose policy carries different thresholds and a different
  approver.
- Two expenses with the same amount but different ids, and two from the same
  submitter. Neither is a duplicate.
- Reading the policy again after listing. A read with no side effect may be
  repeated.
- Escalation approval withheld. The run ends awaiting confirmation, having
  approved what it could.
