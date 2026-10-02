// Vercel serverless demo endpoint for stripe-qbo-reconciler.
//
// Loads the included sample month (data/sample/), runs the real
// reconciliation engine (src/reconcile.js) with the deterministic rules
// provider — the reconcile() default; no Jev key is configured on Vercel —
// and returns the summary as JSON. Read-only: no exports are written.

import { readFileSync } from 'node:fs';
import { reconcile } from '../src/reconcile.js';

function loadJson(rel) {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

const money = (cents) => Number(((cents ?? 0) / 100).toFixed(2));

export default async function handler(req, res) {
  try {
    const payouts = loadJson('../data/sample/stripe-payouts.json');
    const transactions = loadJson('../data/sample/balance-transactions.json');
    const deposits = loadJson('../data/sample/bank-deposits.json');

    const { results, summary } = await reconcile({ payouts, transactions, deposits });

    const exceptions = results
      .filter((r) => r.status === 'exception')
      .map((r) => ({
        payoutId: r.payoutId,
        category: r.classification?.category ?? 'review',
        anomalyRisk: r.classification?.anomalyRisk ?? null,
        reason: r.reason,
      }));

    res.status(200).json({
      product: 'stripe-qbo-reconciler',
      dataset: 'sample month — September 2026 (synthetic data in data/sample/)',
      decisionProvider: summary.providerName,
      payoutsProcessed: summary.payoutCount,
      matchedCount: summary.matchedCount,
      exceptionCount: summary.exceptionCount,
      autoMatchPct: Math.round(summary.autoMatchPct * 10) / 10,
      totalsUSD: {
        grossSales: money(summary.totals.gross),
        stripeFees: money(summary.totals.fees),
        refunds: money(summary.totals.refunds),
        chargebacks: money(summary.totals.chargebacks),
        netPaidOut: money(summary.totals.net),
      },
      exceptions,
    });
  } catch (err) {
    res.status(500).json({ error: 'demo failed', detail: String(err?.message ?? err) });
  }
}
