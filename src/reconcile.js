// Payout-level reconciliation engine.
//
// For every Stripe payout it:
//   1. groups the payout's balance transactions,
//   2. verifies  payout.amount == gross - fees - refunds - chargebacks,
//   3. splits the payout into booking lines (gross sales / Stripe fees /
//      refunds / chargebacks / net to bank clearing, plus a suspense line
//      when the payout does not foot),
//   4. matches the payout to a bank deposit by amount within a date window,
//   5. flags exceptions and classifies them via the DecisionProvider.
//
// All money is integer cents internally.

import { RulesProvider } from "./providers.js";

export const DEPOSIT_WINDOW_DAYS = 3;

export const ACCOUNTS = {
  bankClearing: "Bank Clearing — Stripe Payouts",
  salesRevenue: "Sales Revenue",
  stripeFees: "Stripe Processing Fees",
  refunds: "Refunds (Contra Revenue)",
  chargebacks: "Chargebacks (Contra Revenue)",
  suspense: "Unreconciled Difference (Suspense)",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

export function summarizeTransactions(txns) {
  const s = { gross: 0, fees: 0, refunds: 0, chargebacks: 0, chargebackFees: 0 };
  for (const t of txns) {
    if (t.type === "charge") {
      s.gross += t.amount;
      s.fees += t.fee || 0;
    } else if (t.type === "refund") {
      s.refunds += t.amount;
    } else if (t.type === "chargeback") {
      s.chargebacks += t.amount;
      s.chargebackFees += t.fee || 0;
    }
  }
  s.fees += s.chargebackFees;
  s.computedNet = s.gross - s.fees - s.refunds - s.chargebacks;
  return s;
}

function bookingLines(payout, s, mismatchCents) {
  const lines = [];
  const dr = (account, cents, description) =>
    lines.push({ account, debit: cents, credit: 0, description });
  const cr = (account, cents, description) =>
    lines.push({ account, debit: 0, credit: cents, description });

  dr(ACCOUNTS.bankClearing, payout.amount, `Stripe payout ${payout.id} to bank`);
  if (s.fees > 0) dr(ACCOUNTS.stripeFees, s.fees, "Stripe processing fees");
  if (s.refunds > 0) dr(ACCOUNTS.refunds, s.refunds, "Customer refunds");
  if (s.chargebacks > 0) dr(ACCOUNTS.chargebacks, s.chargebacks, "Chargebacks");
  cr(ACCOUNTS.salesRevenue, s.gross, "Gross sales for payout period");
  // If the payout does not foot, park the difference in suspense so the
  // journal always balances and the gap is impossible to miss.
  if (mismatchCents > 0) cr(ACCOUNTS.suspense, mismatchCents, "Payout exceeded computed net");
  if (mismatchCents < 0) dr(ACCOUNTS.suspense, -mismatchCents, "Payout short of computed net");
  return lines;
}

function reasonFor(result, classification) {
  const p = result;
  const dollars = (c) => `$${(Math.abs(c) / 100).toFixed(2)}`;
  if (classification?.category === "possible_duplicate" || p.duplicateChargeCount > 0) {
    return `${p.duplicateChargeCount} charge(s) also appear in another payout — possible duplicate`;
  }
  if (!p.depositMatched) {
    return `No bank deposit of ${dollars(p.amount)} found within ${DEPOSIT_WINDOW_DAYS} days of payout`;
  }
  if (p.mismatchCents !== 0) {
    return `Payout is ${dollars(p.mismatchCents)} ${p.mismatchCents < 0 ? "less" : "more"} than gross − fees − refunds`;
  }
  if (p.hasChargeback) return "Contains a chargeback — review before booking";
  return "Flagged for review";
}

export async function reconcile({ payouts, transactions, deposits }, provider) {
  const activeProvider = provider ?? new RulesProvider();
  const fallback = new RulesProvider();

  const txByPayout = new Map();
  for (const t of transactions) {
    if (!txByPayout.has(t.payoutId)) txByPayout.set(t.payoutId, []);
    txByPayout.get(t.payoutId).push(t);
  }

  // A charge transaction id showing up under two payouts = duplicated data.
  const payoutsByTxnId = new Map();
  for (const t of transactions) {
    if (!payoutsByTxnId.has(t.id)) payoutsByTxnId.set(t.id, new Set());
    payoutsByTxnId.get(t.id).add(t.payoutId);
  }

  const usedDeposits = new Set();
  const results = [];

  for (const payout of [...payouts].sort((a, b) => a.date.localeCompare(b.date))) {
    const txns = txByPayout.get(payout.id) ?? [];
    const s = summarizeTransactions(txns);
    const mismatchCents = payout.amount - s.computedNet;
    const duplicateChargeCount = txns.filter(
      (t) => t.type === "charge" && payoutsByTxnId.get(t.id).size > 1
    ).length;
    const hasChargeback = s.chargebacks > 0;
    const refundAmounts = txns.filter((t) => t.type === "refund").map((t) => t.amount);

    // Match a bank deposit: exact amount, deposit dated payout date .. +window.
    let deposit = null;
    for (const d of deposits) {
      if (usedDeposits.has(d.id) || d.amount !== payout.amount) continue;
      const dd = dayDiff(payout.date, d.date);
      if (dd >= 0 && dd <= DEPOSIT_WINDOW_DAYS) {
        deposit = d;
        break;
      }
    }
    if (deposit) usedDeposits.add(deposit.id);

    const result = {
      payoutId: payout.id,
      date: payout.date,
      amount: payout.amount,
      gross: s.gross,
      fees: s.fees,
      refunds: s.refunds,
      chargebacks: s.chargebacks,
      computedNet: s.computedNet,
      mismatchCents,
      depositMatched: Boolean(deposit),
      depositId: deposit?.id ?? null,
      duplicateChargeCount,
      hasChargeback,
      lines: bookingLines(payout, s, mismatchCents),
      status: "matched",
      classification: null,
      reason: null,
    };

    const needsReview =
      mismatchCents !== 0 || !deposit || duplicateChargeCount > 0 || hasChargeback;

    if (needsReview) {
      const ctx = {
        payoutId: payout.id,
        amountMismatchCents: mismatchCents,
        hasChargeback,
        duplicateChargeCount,
        depositMatched: Boolean(deposit),
        hasRefunds: s.refunds > 0,
        mismatchEqualsRefundAmount: refundAmounts.some((a) => Math.abs(a) === Math.abs(mismatchCents) && mismatchCents !== 0),
        grossCents: s.gross,
        computedNetCents: s.computedNet,
      };
      let classification;
      try {
        classification = await activeProvider.classify(ctx);
      } catch {
        classification = await fallback.classify(ctx);
        classification = { ...classification, source: "rules-fallback" };
      }
      result.status = "exception";
      result.classification = classification;
      result.reason = reasonFor(result, classification);
    }

    results.push(result);
  }

  const matched = results.filter((r) => r.status === "matched");
  const exceptions = results.filter((r) => r.status === "exception");
  const totals = results.reduce(
    (acc, r) => ({
      gross: acc.gross + r.gross,
      fees: acc.fees + r.fees,
      refunds: acc.refunds + r.refunds,
      chargebacks: acc.chargebacks + r.chargebacks,
      net: acc.net + r.amount,
    }),
    { gross: 0, fees: 0, refunds: 0, chargebacks: 0, net: 0 }
  );

  return {
    results,
    summary: {
      payoutCount: results.length,
      matchedCount: matched.length,
      exceptionCount: exceptions.length,
      autoMatchPct: results.length ? (matched.length / results.length) * 100 : 0,
      totals,
      providerName: activeProvider.name,
    },
  };
}
