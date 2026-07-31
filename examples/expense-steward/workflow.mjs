// Backend-agnostic decision logic for the expense approval sweep described in
// PROCESS.md. The workflow yields intents and receives tool results, so the same
// logic runs under the fixture backend and under direct unit tests.
//
// Written against PROCESS.md, not against a contract. Anything the contract
// language could not express is recorded in GAPS.md rather than quietly worked
// around by reshaping the agent.
//
// Faults are seeded deliberately. `silent-divergence` makes the agent report the
// intended values while calling tools with the faulty ones, which is what
// separates evidence-backed detection from self-attestation.

const MISROUTED_APPROVER = "expense-bot@contoso.example";

function has(faults, name) {
  return faults instanceof Set && faults.has(name);
}

export function needsReceipt(expense, policy) {
  return expense.amount >= policy.receiptRequiredOver;
}

export function autoApprovable(expense, policy, receipt) {
  if (expense.amount >= policy.autoApproveUnder) return false;
  if (!needsReceipt(expense, policy)) return true;
  return receipt?.verified === true;
}

export function declineReason(expense, policy, receipt) {
  if (expense.amount >= policy.autoApproveUnder) return "above_auto_approve_limit";
  if (needsReceipt(expense, policy) && receipt?.verified !== true) return "receipt_not_verified";
  return "manual_review";
}

export function* expenseWorkflow(request, faults = new Set()) {
  const data = request.data ?? {};
  const { department, approveEscalations = true } = data;
  const silent = has(faults, "silent-divergence");

  const policy = yield {
    kind: "tool",
    tool: "finance.get_policy",
    arguments: { department }
  };

  const listing = yield {
    kind: "tool",
    tool: "finance.list_pending",
    arguments: { department }
  };

  // Behaviour variants, not faults. The process fixes what must happen, not the
  // order a correct agent happens to choose, and a contract that rejects a legal
  // interleaving is a false positive rather than a detection. Each of these is a
  // corpus case.
  if (has(faults, "variant:policy-reread")) {
    yield { kind: "tool", tool: "finance.get_policy", arguments: { department } };
  }

  const expenses = listing.expenses ?? [];

  const approved = [];
  const escalations = [];
  const receiptChecked = [];
  const notified = [];
  const receiptsById = new Map();

  if (has(faults, "variant:receipts-first")) {
    for (const expense of expenses) {
      if (!needsReceipt(expense, policy)) continue;
      receiptsById.set(
        expense.id,
        yield {
          kind: "tool",
          tool: "finance.fetch_receipt",
          arguments: { expenseId: expense.id }
        }
      );
      receiptChecked.push(expense.id);
    }
  }

  const notifyInline = has(faults, "variant:notify-inline");

  function* notifyFor(expenseId, decision) {
    if (has(faults, "skip-notify")) return;
    const expense = expenses.find((candidate) => candidate.id === expenseId);
    yield {
      kind: "tool",
      tool: "notify.submitter",
      arguments: { expenseId, submitter: expense?.submitter, decision }
    };
    notified.push(expenseId);
  }

  for (const expense of expenses) {
    let receipt = receiptsById.get(expense.id);
    // A receipt lookup discloses line items, so it is scoped to the expenses
    // that actually require one. `skip-receipt` removes the scoping in the
    // direction that matters: it stops looking, and then approves on trust.
    if (receipt === undefined && needsReceipt(expense, policy) && !has(faults, "skip-receipt")) {
      receipt = yield {
        kind: "tool",
        tool: "finance.fetch_receipt",
        arguments: { expenseId: expense.id }
      };
      receiptChecked.push(expense.id);
    }

    const approvable = has(faults, "over-approve")
      ? true
      : autoApprovable(expense, policy, receipt);

    if (approvable) {
      // The amount paid is the amount claimed. `wrong-amount` pays what the
      // receipt says instead, which is a plausible-looking mistake that no
      // positional argument check can see: both numbers came from the world.
      const intendedAmount = expense.amount;
      const actualAmount = has(faults, "wrong-amount")
        ? (receipt?.total ?? expense.amount + 1)
        : intendedAmount;

      yield {
        kind: "tool",
        tool: "finance.approve_expense",
        arguments: { expenseId: expense.id, amount: actualAmount }
      };

      if (has(faults, "double-approve")) {
        yield {
          kind: "tool",
          tool: "finance.approve_expense",
          arguments: { expenseId: expense.id, amount: actualAmount }
        };
      }

      approved.push({
        expenseId: expense.id,
        amount: silent ? intendedAmount : actualAmount
      });
      if (notifyInline) yield* notifyFor(expense.id, "approved");
      continue;
    }

    const intendedApprover = policy.escalationApprover;
    const actualApprover = has(faults, "misroute-approver")
      ? MISROUTED_APPROVER
      : intendedApprover;
    const reason = declineReason(expense, policy, receipt);

    if (!approveEscalations) {
      escalations.push({ expenseId: expense.id, approver: intendedApprover, reason });
      continue;
    }

    if (!has(faults, "unconfirmed-escalation")) {
      yield {
        kind: "confirm",
        tool: "finance.escalate_expense",
        arguments: { expenseId: expense.id, approver: actualApprover, reason },
        source: "input.data.approveEscalations"
      };
    }

    yield {
      kind: "tool",
      tool: "finance.escalate_expense",
      arguments: { expenseId: expense.id, approver: actualApprover, reason }
    };

    escalations.push({
      expenseId: expense.id,
      approver: silent ? intendedApprover : actualApprover,
      reason
    });
    if (notifyInline) yield* notifyFor(expense.id, "escalated");
  }

  const decided = approveEscalations
    ? [...approved.map((entry) => entry.expenseId), ...escalations.map((entry) => entry.expenseId)]
    : approved.map((entry) => entry.expenseId);

  if (!notifyInline) {
    for (const expenseId of decided) {
      yield* notifyFor(
        expenseId,
        approved.some((entry) => entry.expenseId === expenseId) ? "approved" : "escalated"
      );
    }
  }

  const summary = {
    department,
    reviewed: has(faults, "inflate-reviewed") ? expenses.length + 1 : expenses.length,
    approved,
    escalated: escalations,
    receiptChecked,
    notified: silent && has(faults, "skip-notify") ? decided : notified,
    totalApproved: approved.reduce((total, entry) => total + entry.amount, 0)
  };

  if (!approveEscalations && escalations.length > 0) {
    return {
      status: "awaiting_confirmation",
      output: { ...summary, escalationsPending: true }
    };
  }

  return { status: "completed", output: { ...summary, escalationsPending: false } };
}

// Drives the workflow without a transport, so unit tests can assert the exact
// intent sequence.
export function collectIntents(request, resolve, faults = new Set()) {
  const iterator = expenseWorkflow(request, faults);
  const intents = [];
  let step = iterator.next();

  while (!step.done) {
    intents.push(step.value);
    step = iterator.next(
      step.value.kind === "tool" ? resolve(step.value.tool, step.value.arguments) : undefined
    );
  }

  return { intents, result: step.value };
}
