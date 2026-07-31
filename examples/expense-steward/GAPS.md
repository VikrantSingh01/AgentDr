# Measured gaps in the contract language

Everything here was found by measurement, not by inspection: each entry is a
mutation the corpus generated, or a correct-behaviour world the corpus contains,
that the contract language could not handle. They are recorded rather than
worked around, because a survivor that is written down is a boundary and a
survivor that is quietly excluded is a lie about the score.

## Open

### `totalApproved` — no aggregate over a reported collection

`misreport-outcome:totalApproved` survives in `examples/expense-steward`. The
agent reports a set of approvals and a total, and the total can be wrong while
every approval is correct. The invariant is a sum:

```
totalApproved == sum of approved[].amount
```

The language can tie a reported value to a single result, to the size of a
retrieved set (`length: true`), or to another reported value through JSON Schema
`allOf`. It cannot fold a collection. Only the degenerate case is expressible
and is asserted today: an empty `approved` forces `totalApproved` to zero.

An aggregate operator would close this, and the same operator would cover counts
per category, totals per approver, and any other rolled-up figure. It has not
been added because no second use has appeared yet, and one motivating example is
not enough evidence to shape an operator around.

## Closed, and what closed them

Kept because each one describes a class of defect that was invisible before, and
the reasoning is the reusable part.

| Gap | Construct | Found by |
| --- | --- | --- |
| A selection policy with a numeric bound could only be written as a literal threshold, which pins the contract to one policy | `$lessThan` / `$atMost` / `$greaterThan` / `$atLeast`, resolving the bound through the same machinery as any other reference | Authoring the expense contract; the policy publishes the limit, so freezing it would have measured the fixture |
| A producing call could only be selected by its arguments, so a lookup that takes an id and returns a verdict could not be joined on the verdict | `whereResult` | First run of the expense contract, which could not express "a receipt that came back verified" |
| A value correlated to whichever of two mutually exclusive actions was taken could not be stated | `$anyOf` in the value position, resolving to the union of candidate sets | Four `swap-arg:*:decision` mutants: an expense was approved and the submitter was told it had been escalated |
| Evidence gathered about a record could not be required to precede the action on that record | `correlate` on a precedence rule | `reorder:6`, which escalated an expense before fetching the receipt it then reported having checked |
| An obligation owed for either of two outcomes could only name one of them, forbidding the call in every world where the other happened alone | `$anyOf` in a conditional obligation | Two false positives in the corpus: worlds where nothing was approvable and the agent correctly notified every escalated submitter |

## A note on the instrument

`reorder:4` was being excluded from the denominator as behaviour-preserving. It
approved an expense and then fetched the receipt, producing the same set of calls
and the same report — but not the same act, because the approval could not have
been informed by a receipt that had not arrived. The harness's fingerprint said
order never matters, which is false in any domain where a decision has to be
grounded in evidence already gathered.

The fingerprint now carries, for each state-changing call, the reads that
preceded it, and compares them directionally: a write may gain context and still
be the same act, but a write that has lost a read it stood on is a different act.
Requiring the sets to be equal instead would have flagged every harmless
interleaving of independent records.

Applying the same correction to `em-triage-steward` left its score at exactly
98.1 percent with the same single survivor, which is the evidence that the change
sharpened the instrument rather than moving the numbers.
