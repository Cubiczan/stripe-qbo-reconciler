// Generates one month of synthetic Stripe data (September 2026) plus the
// corresponding bank deposits, so the whole pipeline runs offline.
//
// The month contains planted anomalies that the reconciler must catch
// (see `groundTruth`):
//   - a payout whose amount is $12.34 short of gross - fees - refunds
//     (an unrecorded fee/adjustment -> fee_mismatch)
//   - a payout with no matching bank deposit (-> missing_deposit)
//   - two payouts built from the *same* charge transactions
//     (-> possible_duplicate)
//   - a payout containing a chargeback (-> chargeback review)
//
// All amounts are integer cents, Stripe-style. Deterministic (seeded PRNG),
// so the generated files and the tests are stable.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// mulberry32 — tiny deterministic PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(42);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
// Stripe's standard pricing: 2.9% + 30c per successful charge.
const stripeFee = (amountCents) => Math.round(amountCents * 0.029) + 30;

function isoDate(base, plusDays) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

export function generateSampleData() {
  const payouts = [];
  const transactions = [];
  const deposits = [];
  const groundTruth = {
    feeMismatchPayoutId: null,
    missingDepositPayoutId: null,
    duplicatePayoutIds: [],
    chargebackPayoutId: null,
  };

  const monthStart = Date.UTC(2026, 8, 1); // 2026-09-01
  const payoutCount = 14;
  let txnSeq = 1;
  let previousChargeTxns = null;

  for (let i = 0; i < payoutCount; i++) {
    const payoutId = `po_${1001 + i}`;
    const payoutDate = isoDate(monthStart, 2 + i * 2); // every 2 days
    const isDuplicate = i === 8;
    const isSourceOfDuplicate = i === 7;
    const hasChargeback = i === 4;
    const hasFeeMismatch = i === 5;
    const isMissingDeposit = i === 11;

    let payoutTxns;
    if (isDuplicate) {
      // Same underlying charges as the previous payout, re-listed.
      payoutTxns = previousChargeTxns.map((t) => ({ ...t, payoutId }));
      groundTruth.duplicatePayoutIds = [previousChargeTxns[0].payoutId, payoutId];
    } else {
      payoutTxns = [];
      const chargeCount = int(5, 16);
      for (let c = 0; c < chargeCount; c++) {
        const amount = int(1200, 48000); // $12.00 - $480.00
        payoutTxns.push({
          id: `txn_${String(txnSeq++).padStart(4, "0")}`,
          payoutId,
          type: "charge",
          amount,
          fee: stripeFee(amount),
          created: payoutDate,
          description: `Charge ch_${2000 + txnSeq}`,
        });
      }
      // ~1 in 3 ordinary payouts carries a refund of its first charge.
      if (i % 3 === 1) {
        const first = payoutTxns[0];
        payoutTxns.push({
          id: `txn_${String(txnSeq++).padStart(4, "0")}`,
          payoutId,
          type: "refund",
          amount: first.amount,
          fee: 0,
          created: payoutDate,
          description: `Refund of ${first.description}`,
        });
      }
      if (hasChargeback) {
        const amount = 12000; // $120.00 disputed charge
        payoutTxns.push({
          id: `txn_${String(txnSeq++).padStart(4, "0")}`,
          payoutId,
          type: "chargeback",
          amount,
          fee: 1500, // $15.00 chargeback fee
          created: payoutDate,
          description: "Chargeback dp_3001 (cardholder dispute)",
        });
        groundTruth.chargebackPayoutId = payoutId;
      }
    }

    const computedNet = payoutTxns.reduce((sum, t) => {
      if (t.type === "charge") return sum + t.amount - t.fee;
      return sum - t.amount - (t.fee || 0); // refund / chargeback
    }, 0);

    let payoutAmount = computedNet;
    if (hasFeeMismatch) {
      payoutAmount = computedNet - 1234; // $12.34 vanished: unrecorded adjustment
      groundTruth.feeMismatchPayoutId = payoutId;
    }

    payouts.push({ id: payoutId, date: payoutDate, amount: payoutAmount, currency: "usd" });
    transactions.push(...payoutTxns);
    if (isSourceOfDuplicate) previousChargeTxns = payoutTxns;

    if (isMissingDeposit) {
      groundTruth.missingDepositPayoutId = payoutId;
    } else {
      deposits.push({
        id: `dep_${3001 + i}`,
        date: isoDate(new Date(`${payoutDate}T00:00:00Z`), 1),
        amount: payoutAmount,
        description: `Stripe payout ${payoutId}`,
      });
    }
  }

  return { payouts, transactions, deposits, groundTruth };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, "data", "sample");
  mkdirSync(outDir, { recursive: true });
  const data = generateSampleData();
  writeFileSync(join(outDir, "stripe-payouts.json"), JSON.stringify(data.payouts, null, 2));
  writeFileSync(join(outDir, "balance-transactions.json"), JSON.stringify(data.transactions, null, 2));
  writeFileSync(join(outDir, "bank-deposits.json"), JSON.stringify(data.deposits, null, 2));
  writeFileSync(join(outDir, "ground-truth.json"), JSON.stringify(data.groundTruth, null, 2));
  console.log(
    `Wrote ${data.payouts.length} payouts, ${data.transactions.length} balance transactions, ` +
      `${data.deposits.length} bank deposits to data/sample/`
  );
}
