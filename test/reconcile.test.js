import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, summarizeTransactions } from "../src/reconcile.js";
import { generateSampleData } from "../src/generate-sample.js";
import { RulesProvider } from "../src/providers.js";
import { buildJournal, journalTotals } from "../src/journal.js";

// ---------- payout math ----------

test("payout math: gross/fees/refunds split and net identity", () => {
  const txns = [
    { id: "t1", payoutId: "po_x", type: "charge", amount: 10000, fee: 320 },
    { id: "t2", payoutId: "po_x", type: "charge", amount: 5000, fee: 175 },
    { id: "t3", payoutId: "po_x", type: "refund", amount: 5000, fee: 0 },
  ];
  const s = summarizeTransactions(txns);
  assert.equal(s.gross, 15000);
  assert.equal(s.fees, 495);
  assert.equal(s.refunds, 5000);
  assert.equal(s.chargebacks, 0);
  assert.equal(s.computedNet, 15000 - 495 - 5000);
});

test("clean payout auto-matches and booking lines balance", async () => {
  const payouts = [{ id: "po_x", date: "2026-09-05", amount: 9505, currency: "usd" }];
  const transactions = [
    { id: "t1", payoutId: "po_x", type: "charge", amount: 10000, fee: 320 },
    { id: "t2", payoutId: "po_x", type: "charge", amount: 5000, fee: 175 },
    { id: "t3", payoutId: "po_x", type: "refund", amount: 5000, fee: 0 },
  ];
  const deposits = [{ id: "d1", date: "2026-09-06", amount: 9505 }];
  const { results, summary } = await reconcile({ payouts, transactions, deposits });
  assert.equal(summary.matchedCount, 1);
  assert.equal(results[0].status, "matched");
  const dr = results[0].lines.reduce((a, l) => a + l.debit, 0);
  const cr = results[0].lines.reduce((a, l) => a + l.credit, 0);
  assert.equal(dr, cr);
  const accounts = results[0].lines.map((l) => l.account);
  assert.ok(accounts.some((a) => a.includes("Sales Revenue")));
  assert.ok(accounts.some((a) => a.includes("Processing Fees")));
  assert.ok(accounts.some((a) => a.includes("Refunds")));
  assert.ok(accounts.some((a) => a.includes("Bank Clearing")));
});

// ---------- signed Stripe-style input ----------

test("signed amounts (real Stripe convention) are normalized to magnitudes", () => {
  const txns = [
    { id: "t1", payoutId: "po_s", type: "charge", amount: 10000, fee: 320 },
    { id: "t2", payoutId: "po_s", type: "refund", amount: -5000, fee: 0 },
    { id: "t3", payoutId: "po_s", type: "chargeback", amount: -12000, fee: 1500 },
  ];
  const s = summarizeTransactions(txns);
  assert.equal(s.gross, 10000);
  assert.equal(s.refunds, 5000);
  assert.equal(s.chargebacks, 12000);
  assert.equal(s.fees, 320 + 1500);
  assert.equal(s.computedNet, 10000 - 1820 - 5000 - 12000);
});

test("negative fee (fee return) cannot unbalance the journal", async () => {
  // Counterexample from the Lean review: fees = -100 with mismatch 0 used
  // to produce debits 10100 != credits 10000, because computedNet added the
  // negative fee back while bookingLines dropped the non-positive fee line.
  const payouts = [{ id: "po_n", date: "2026-09-05", amount: 9900, currency: "usd" }];
  const transactions = [
    { id: "t1", payoutId: "po_n", type: "charge", amount: 10000, fee: -100 },
  ];
  const deposits = [{ id: "d1", date: "2026-09-06", amount: 9900 }];
  const { results } = await reconcile({ payouts, transactions, deposits });
  assert.equal(results[0].fees, 100);
  assert.equal(results[0].computedNet, 9900);
  assert.equal(results[0].mismatchCents, 0);
  const dr = results[0].lines.reduce((a, l) => a + l.debit, 0);
  const cr = results[0].lines.reduce((a, l) => a + l.credit, 0);
  assert.equal(dr, cr);
});

test("signed chargeback payout is flagged as an exception, never auto-matched", async () => {
  const payouts = [{ id: "po_cb", date: "2026-09-05", amount: 8300, currency: "usd" }];
  const transactions = [
    { id: "t1", payoutId: "po_cb", type: "charge", amount: 20000, fee: 200 },
    { id: "t2", payoutId: "po_cb", type: "chargeback", amount: -10000, fee: 1500 },
  ];
  const deposits = [{ id: "d1", date: "2026-09-06", amount: 8300 }];
  const { results } = await reconcile({ payouts, transactions, deposits });
  assert.equal(results[0].chargebacks, 10000);
  assert.equal(results[0].computedNet, 8300);
  assert.equal(results[0].status, "exception");
  assert.equal(results[0].classification.category, "chargeback");
  const dr = results[0].lines.reduce((a, l) => a + l.debit, 0);
  const cr = results[0].lines.reduce((a, l) => a + l.credit, 0);
  assert.equal(dr, cr);
});

// ---------- deposit matching ----------

test("deposit matching: exact amount within the date window", async () => {
  const base = {
    payouts: [{ id: "po_a", date: "2026-09-10", amount: 5000, currency: "usd" }],
    transactions: [{ id: "t1", payoutId: "po_a", type: "charge", amount: 5290, fee: 290 }],
  };
  const inWindow = await reconcile({
    ...base,
    deposits: [{ id: "d1", date: "2026-09-13", amount: 5000 }], // +3 days: inside
  });
  assert.equal(inWindow.results[0].depositMatched, true);
  assert.equal(inWindow.results[0].status, "matched");

  const outWindow = await reconcile({
    ...base,
    deposits: [{ id: "d1", date: "2026-09-15", amount: 5000 }], // +5 days: outside
  });
  assert.equal(outWindow.results[0].depositMatched, false);
  assert.equal(outWindow.results[0].status, "exception");
  assert.equal(outWindow.results[0].classification.category, "missing_deposit");

  const wrongAmount = await reconcile({
    ...base,
    deposits: [{ id: "d1", date: "2026-09-11", amount: 4999 }],
  });
  assert.equal(wrongAmount.results[0].depositMatched, false);
});

// ---------- planted discrepancies in the sample month ----------

test("planted discrepancies in sample data are caught and classified", async () => {
  const data = generateSampleData();
  const { results, summary } = await reconcile(data);
  const byId = new Map(results.map((r) => [r.payoutId, r]));
  const gt = data.groundTruth;

  const feeMismatch = byId.get(gt.feeMismatchPayoutId);
  assert.equal(feeMismatch.status, "exception");
  assert.equal(feeMismatch.mismatchCents, -1234);
  assert.equal(feeMismatch.classification.category, "fee_mismatch");

  const missing = byId.get(gt.missingDepositPayoutId);
  assert.equal(missing.status, "exception");
  assert.equal(missing.depositMatched, false);
  assert.equal(missing.classification.category, "missing_deposit");

  assert.equal(gt.duplicatePayoutIds.length, 2);
  for (const id of gt.duplicatePayoutIds) {
    const dup = byId.get(id);
    assert.ok(dup.duplicateChargeCount > 0, `${id} should show duplicated charges`);
    // Both payouts involved in the duplication are flagged for review —
    // the engine cannot tell which one is authoritative.
    assert.equal(dup.status, "exception");
    assert.equal(dup.classification.category, "possible_duplicate");
    assert.equal(dup.classification.isDuplicate, true);
  }

  const cb = byId.get(gt.chargebackPayoutId);
  assert.equal(cb.status, "exception");
  assert.equal(cb.classification.category, "chargeback");
  assert.ok(cb.chargebacks > 0);

  // Exactly the planted anomalies are exceptions — nothing else.
  // (4 planted anomalies, but the duplicate implicates 2 payouts -> 5.)
  assert.equal(summary.exceptionCount, 5, JSON.stringify(results.filter(r => r.status === "exception").map(r => r.payoutId)));
});

// ---------- journal export ----------

test("journal export totals balance (debits = credits), per entry and overall", async () => {
  const data = generateSampleData();
  const { results } = await reconcile(data);
  const journal = buildJournal(results);
  assert.equal(journal.length, data.payouts.length);
  for (const entry of journal) {
    const dr = entry.lines.reduce((a, l) => a + Math.round(l.debit * 100), 0);
    const cr = entry.lines.reduce((a, l) => a + Math.round(l.credit * 100), 0);
    assert.equal(dr, cr, `entry ${entry.docNumber} must balance`);
  }
  const totals = journalTotals(journal);
  assert.equal(totals.balanced, true);
  assert.ok(totals.debitCents > 0);
});

test("fee-mismatch journal entry carries a suspense line", async () => {
  const data = generateSampleData();
  const { results } = await reconcile(data);
  const r = results.find((x) => x.payoutId === data.groundTruth.feeMismatchPayoutId);
  assert.ok(r.lines.some((l) => l.account.includes("Suspense")));
});

// ---------- rules provider ----------

test("rules provider classifies each signal deterministically", async () => {
  const p = new RulesProvider();
  const base = {
    payoutId: "po_t",
    amountMismatchCents: 0,
    hasChargeback: false,
    duplicateChargeCount: 0,
    depositMatched: true,
    hasRefunds: false,
    mismatchEqualsRefundAmount: false,
    grossCents: 10000,
    computedNetCents: 9500,
  };
  assert.equal((await p.classify({ ...base, duplicateChargeCount: 3 })).category, "possible_duplicate");
  assert.equal((await p.classify({ ...base, depositMatched: false })).category, "missing_deposit");
  assert.equal((await p.classify({ ...base, amountMismatchCents: -1234 })).category, "fee_mismatch");
  assert.equal(
    (await p.classify({ ...base, amountMismatchCents: -5000, hasRefunds: true, mismatchEqualsRefundAmount: true })).category,
    "refund_timing"
  );
  assert.equal((await p.classify({ ...base, hasChargeback: true })).category, "chargeback");
  const risk = await p.classify({ ...base, amountMismatchCents: -1234 });
  assert.ok(risk.anomalyRisk >= 1 && risk.anomalyRisk <= 5);
});
