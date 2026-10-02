# Stripe → QuickBooks Payout Reconciler

Ecommerce sellers routinely lose **~10 hours a month** hand-matching Stripe
payouts into QuickBooks. The reason it's slow is the reason it matters: a
Stripe payout is a *net* number, but the books need the *split*. Every payout
has to be broken into **gross sales, Stripe fees, and refunds** before it can
be booked.

Book the net payout as revenue — the shortcut everyone is tempted by — and
two things go wrong at once:

- **Revenue is understated.** Fees and refunds silently shrink the top line.
- **Processing costs disappear.** Stripe fees never hit the P&L as an
  expense, so margins look better than they are and fee changes go unnoticed.

This repo is a reference implementation of the fix: payout-level
reconciliation that splits every payout, proves it against the bank, and
exports journal entries QuickBooks can import — booking humans only for the
exceptions that actually need judgment.

## Pipeline

```
Stripe payouts + balance transactions ──┐
                                        ├─► reconcile ─► journal export (JSON/CSV)
Bank deposits ──────────────────────────┘        │
                                                 └─► exceptions ─► DecisionProvider
                                                                      (Jev or rules)
```

1. **Group & verify.** Balance transactions (charges, fees, refunds,
   chargebacks) are grouped by payout. Each payout must foot:
   `payout = gross − fees − refunds − chargebacks`.
2. **Split.** Every payout becomes booking lines: gross sales, Stripe
   processing fees, refunds (contra-revenue), chargebacks, and the net to
   the bank clearing account. A payout that doesn't foot gets an explicit
   *Unreconciled Difference (Suspense)* line — the journal always balances
   and the gap can't hide.
3. **Match.** Payouts are matched to bank deposits by exact amount within a
   3-day window.
4. **Classify exceptions.** Anything that doesn't foot, doesn't match a
   deposit, duplicates charges from another payout, or contains a
   chargeback is routed to a DecisionProvider for classification instead of
   being silently booked.

## Quickstart

Requires Node 20+. Zero dependencies; runs fully offline on synthetic data.

```bash
npm test        # node:test suite — payout math, deposit matching,
                # planted-discrepancy detection, journal balance
npm run demo    # full pipeline on the sample month + summary report
npm run generate  # regenerate data/sample/ (deterministic, seeded)
```

The sample month (September 2026, in `data/sample/`) contains 14 payouts
and 156 balance transactions, with planted anomalies the engine must catch:
a $12.34 fee mismatch, a payout with no bank deposit, two payouts built
from the same charges, and a chargeback. A typical demo run auto-matches
~64% of payouts and surfaces exactly those planted exceptions.

## Export format

`npm run demo` writes `data/exports/journal-entries.json` and
`journal-entries.csv` — one journal entry per payout, dated to the payout
date, with separate lines for:

| Account | Side | What it is |
|---|---|---|
| Bank Clearing — Stripe Payouts | Debit | Net payout amount |
| Stripe Processing Fees | Debit | All Stripe fees in the payout |
| Refunds (Contra Revenue) | Debit | Refunds in the payout |
| Chargebacks (Contra Revenue) | Debit | Chargebacks in the payout |
| Sales Revenue | Credit | **Gross** sales — the number net-booking loses |
| Unreconciled Difference (Suspense) | Either | Only when a payout doesn't foot |

The CSV uses QBO-friendly columns (`TxnDate, DocNumber, PayoutId, Account,
Debit, Credit, Description`) so entries can be reviewed and imported.
Debits equal credits per entry and in total — this is asserted by the test
suite.

## Exception classification (Jev)

Classification sits behind a `DecisionProvider` interface
(`src/providers.js`):

- **`JevProvider`** — used when `JEV_API_KEY` is set (see `.env.example`).
  It calls TypeSafe AI's Jev System One model
  (`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`) with
  three typed questions asked in parallel over the payout's reconciliation
  signals: a **choice** for category (`fee_mismatch`, `refund_timing`,
  `chargeback`, `possible_duplicate`, `missing_deposit`, `other`), a
  **noul** for duplicate probability, and a **score** for anomaly risk on a
  1–5 rubric. Fast, calibrated, typed answers are exactly what an exception
  queue needs — no prose to parse.
- **`RulesProvider`** — deterministic rules over the same signals. This is
  the default (no key required, works offline) and the automatic fallback
  if a Jev call fails.

The key is read from the environment only and never printed.

## Layout

```
src/generate-sample.js  synthetic month of Stripe payouts + bank deposits
src/reconcile.js        matching engine: verify, split, match, flag
src/providers.js        DecisionProvider interface: Jev + rules fallback
src/journal.js          QBO journal entries (JSON/CSV), balance checks
src/demo.js             end-to-end demo + summary report
test/                   node:test suite
data/sample/            generated inputs (incl. ground-truth.json)
data/exports/           generated journal exports
```

## Production notes

This is a reference build on synthetic data — no live Stripe or QuickBooks
credentials are used. Wiring it to production means swapping the sample
loader for the Stripe Balance Transactions API and a bank feed, pointing
the export at QBO's journal-entry import/API, and reviewing the suspense
account weekly. The reconciliation math, exception taxonomy, and provider
interface carry over unchanged.

---

Offered by **Cubiczan** as part of the **Agentic Finance OS** / CFO Command
Center: governed, auditable automation for finance operations — the system
does the matching, humans keep the judgment.
