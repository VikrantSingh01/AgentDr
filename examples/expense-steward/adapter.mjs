#!/usr/bin/env node
// Transport for the expense steward. All mutation machinery is shared with the
// triage steward via examples/mutation/generic-adapter.mjs; this file supplies
// only what is genuinely domain knowledge.

import { runMutationAdapter } from "../mutation/generic-adapter.mjs";
import { expenseWorkflow } from "./workflow.mjs";

const DECISIONS = new Set(["approved", "escalated"]);

runMutationAdapter({
  workflow: expenseWorkflow,

  // Used only by `reorder`, when a later call has to run before the call whose
  // result would normally shape it. Returning a shape the workflow can consume
  // keeps the operator measuring ordering rather than crash-handling.
  syntheticResult(tool, args) {
    if (tool === "finance.get_policy") {
      return {
        department: args.department,
        autoApproveUnder: 500,
        receiptRequiredOver: 250,
        escalationApprover: "finance-approver@contoso.example"
      };
    }
    if (tool === "finance.list_pending") return { department: args.department, expenses: [] };
    if (tool === "finance.fetch_receipt") {
      return { expenseId: args.expenseId, verified: true, total: 0 };
    }
    if (tool === "finance.approve_expense") return { state: "approved", expenseId: args.expenseId };
    if (tool === "finance.escalate_expense") {
      return { state: "escalated", expenseId: args.expenseId, ticketId: "FIN-0" };
    }
    if (tool === "notify.submitter") return { state: "notified", expenseId: args.expenseId };
    return undefined;
  },

  // A substituted value has to be plausible or the contract rejects it on shape
  // alone and the mutant measures the JSON Schema rather than the contract.
  valueFamilies: [
    (value) => typeof value === "string" && /^[^@\s]+@[^@\s]+$/.test(value),
    (value) => typeof value === "string" && /^EXP-\d+$/.test(value),
    (value) => typeof value === "string" && DECISIONS.has(value)
  ]
});
