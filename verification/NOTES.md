# Verification notes — stripe-qbo-reconciler

`Reconcile.lean` is a core-library-only Lean 4 (4.34.1) model of the
reconciliation engine. It compiles with plain `lean Reconcile.lean`
(no lake project, no Mathlib), contains no `sorry`/`admit`/custom axioms
(`#print axioms` shows only `propext`, `Quot.sound`, `Classical.choice`),
and no files under `src/` were modified.

## Model ↔ source mapping

| Lean definition / theorem | Source |
|---|---|
| `Summary` (structure) | Result of `summarizeTransactions`, `src/reconcile.js` ll. 31–48. Only the final fields are modeled: the JS folds chargeback fees into `fees` (`s.fees += s.chargebackFees`, l. 45) before computing the net, matching the task spec. |
| `computedNet` | `src/reconcile.js` l. 46: `gross - fees - refunds - chargebacks`. |
| `mismatch` | `src/reconcile.js` l. 115: `payout.amount - s.computedNet`. |
| `bookingLines` | `src/reconcile.js` ll. 50–69 (`bookingLines(payout, s, mismatchCents)`). Same line order, same guards: bank-clearing debit always (l. 58); fees/refunds/chargebacks debits only when `> 0` (ll. 59–61); gross-sales credit always (l. 62); suspense credit `mismatch` when `mismatch > 0` (l. 65); suspense debit `-mismatch` when `mismatch < 0` (l. 66). Account strings are the exact `ACCOUNTS` values, ll. 14–21. Descriptions are dropped (they carry no arithmetic). |
| `totalDebit` / `totalCredit` | Column sums; counterpart of `journalTotals`, `src/journal.js` ll. 41–52 (modeled in exact integer cents — see discrepancy 8 on the JS dollar round-trip). |
| `journal_balances` — **(a)** | The "journal always balances" claim made by the comment at `src/reconcile.js` ll. 63–64 and `src/journal.js` ll. 5–8. Proved by case analysis on all five guards/signs + `omega`. |
| `eligible` | Deposit eligibility, `src/reconcile.js` ll. 127–133: `!usedDeposits.has(d.id)`, `d.amount === payout.amount`, `0 ≤ dayDiff ≤ DEPOSIT_WINDOW_DAYS` (constant = 3, l. 14). `dayDiff` (l. 29) is abstracted as an arbitrary `dd : Payout → Deposit → Int` — see discrepancy 3. |
| `findFirst` + `findFirst_eq_some` | The inner first-fit scan over the deposits array, ll. 127–133 (first eligible wins, then `break`). |
| `matchAll` / `matchDeposits` | The reconcile loop, ll. 108–134, threading `usedDeposits` (l. 106). Payouts are consumed in list order — the JS sorts by date string first (l. 108), so the model's input list is the post-sort order (see discrepancy 9). Provider classification (ll. 159–177) does not affect matching and is not modeled. |
| `matchAll_fresh_and_nodup`, `no_deposit_matched_twice` — **(b)** | Injectivity: matched deposit ids are `List.Nodup`. The invariant also shows every matched id is fresh w.r.t. the incoming used-set. This is the formal counterpart of `usedDeposits.add(deposit.id)` at l. 134. |
| `matchAll_pairs_eligible`, `matched_pairs_satisfy_eligibility` — **(c)** | Every matched pair `(p, d)` has `d` from the deposits list, `d.amount = p.amount`, and `0 ≤ dd p d ≤ 3`. |
| `needsReview` / `status` | `src/reconcile.js` ll. 140–177: results start as `"matched"` (l. 152) and are overwritten with `"exception"` iff `needsReview` (ll. 156–157, 175). `depositMatched` models `Boolean(deposit)` (l. 142). |
| `status_matched_iff_not_needsReview` — **(d)** | `status = matched ↔ ¬ needsReview`. |
| `status_matched_iff_clean` — **(d′)** | Same, unfolded: matched iff `mismatch = 0 ∧ depositMatched ∧ dupCount ≤ 0 ∧ ¬hasChargeback` (all four conditions clean). |
| `mismatch_ne_zero_status_exception` — **(e)** | `mismatch ≠ 0 → status = exception`: a payout that doesn't foot is never auto-matched. |

Executable spot-checks (via `#eval` on the model, not part of the file):
a footing payout (gross 10000¢, fees 300¢, amount 9700¢) yields exactly
the JS lines and totals (10000, 10000); a 700¢-short payout yields the
suspense **debit** of 700 and balances; two payouts competing for one
deposit match only the first.

## Discrepancies and risks found

1. **The journal does *not* always balance — the theorem needs
   nonnegativity hypotheses.** `journal_balances` is proved under
   `0 ≤ fees`, `0 ≤ refunds`, `0 ≤ chargebacks`, and these are
   load-bearing: `computedNet` subtracts each component unconditionally
   (l. 46), but `bookingLines` emits the corresponding debit line only
   when the component is `> 0` (ll. 59–61), and the suspense line only
   compensates `amount − computedNet`. With a negative component the
   identity fails by exactly that component. Concrete counterexample,
   evaluated on the Lean model: summary `⟨gross 10000, fees −100, 0, 0⟩`,
   `amount = computedNet = 10100` (so `mismatch = 0`, no suspense line)
   gives total debits 10100 ≠ total credits 10000.
   This is reachable with real Stripe data: in the Stripe API, refund
   and chargeback balance transactions carry **negative** `amount`s, and
   `fee` can be negative on fee refunds/adjustments — while
   `summarizeTransactions` adds them raw (ll. 36–42). The synthetic demo
   data uses positive amounts, so the test suite never sees this. With
   signed data the knock-on effects are worse than an unbalanced journal:
   negative refunds/chargebacks make `hasChargeback` (`s.chargebacks > 0`,
   l. 120) false and inflate `computedNet`, so bad payouts can be
   classified `"matched"`. The comments at ll. 63–64 ("the journal always
   balances") and `src/journal.js` ll. 5–8 overclaim.

2. **Zero/negative-amount lines are always emitted.** `bookingLines`
   unconditionally emits the bank-clearing debit of `payout.amount`
   (l. 58) and the sales credit of `s.gross` (l. 62) — even when they are
   0 (zero-value lines exported to QuickBooks) or negative (a negative
   "debit"/"credit", which QBO imports may reject or misinterpret).
   In the CSV export these print as blank debit *and* blank credit
   (`src/journal.js` ll. 35–36 use `l.debit ? … : ""`).

3. **`dayDiff` rounds, so the [0, 3] window is not the real window**
   (l. 29: `Math.round((Date.parse(b) − Date.parse(a)) / DAY_MS)`).
   A deposit 3 days 11 hours after the payout rounds to 3 → eligible
   although more than 3 days late; a deposit ~12 hours *before* the
   payout date rounds to −0 → treated as day 0 → eligible; a deposit at
   +3 days 13 hours rounds to 4 → rejected. DST transitions (23/25-hour
   local days) skew it further since `Date.parse` on date-only strings
   is UTC midnight. The Lean theorems are about the idealized integer
   `dayDiff`; the rounding behavior is outside the model and means
   property (c) holds only approximately for the JS as written.

4. **Greedy first-fit can starve a later payout.** Payouts are processed
   in date order and each takes the *first* eligible deposit in array
   order (ll. 126–134). An early payout can consume the only deposit a
   later payout could have matched, leaving the later one flagged
   "No bank deposit found…" (`reasonFor`, l. 79). The model confirms
   what *is* guaranteed (injectivity, (b)) — but `matchAll` is not a
   maximum bipartite matching, and nothing in the code backtracks.
   Outcomes also depend on the deposits array order, not on closeness
   of dates.

5. **Duplicate detection flags both copies and misses others**
   (ll. 100–105, 117–119). `duplicateChargeCount` counts, per payout,
   charge transactions whose id appears under more than one payout —
   so a duplicated charge makes **both** payouts exceptions, not just
   the spurious one, and both payouts' grosses include it. Conversely:
   a charge repeated *within the same* payout is invisible (the
   `payoutsByTxnId` Set has size 1), and shared non-charge transactions
   (e.g. the same refund in two payouts) are never counted because the
   filter requires `t.type === "charge"` (l. 118) even though the map
   is built over all types (l. 102).

6. **`summarizeTransactions` silently ignores unknown transaction
   types** (ll. 33–43): anything that is not `charge` / `refund` /
   `chargeback` (e.g. `adjustment`, `stripe_fee`, `transfer`) contributes
   nothing to any component. Its amount surfaces only indirectly as an
   unexplained mismatch/suspense — and if the payout also lacks a
   deposit match, `reasonFor` blames the deposit (l. 79) rather than the
   footing gap, since deposit is checked first. Relatedly, transactions
   whose `payoutId` matches no payout are grouped (ll. 93–96) but never
   read — they vanish entirely, not even from totals.

7. **Deposit identity is `id` alone** (ll. 128, 134). If the deposits
   array contains two distinct bank deposits sharing an `id` (e.g. a
   merged export), the second becomes unmatchable once the first is
   used. Theorem (b) is about ids, so it cannot distinguish this case.

8. **`journal.js` money round-trip through floats.** `buildJournal`
   converts cents to dollars via `Math.round(cents) / 100` (l. 10) and
   `journalTotals` converts back with `Math.round(l.debit * 100)`
   (ll. 46–47). Binary floating point makes this lossy in principle;
   the Lean model works in exact integer cents, so theorem (a) is a
   statement about the reconciler's internal representation — the
   exported `balanced` flag in `journalTotals` is a separate,
   float-mediated check.

9. **Payout order is a string sort.** Processing order is
   `a.date.localeCompare(b.date)` (l. 108) — correct for ISO-8601
   dates, fragile for any other format, and same-date payouts are
   ordered by input position, which (per risk 4) can change who gets
   matched. The model takes the processing order as given.

10. **Exceptions are exported as journal entries.** `buildJournal`
    (`src/journal.js` ll. 15–30) maps over *all* results, including
    exceptions — only the memo string marks them `EXCEPTION`. Nothing
    holds exception entries back from a QuickBooks import, so the
    "review" status is advisory only.

---

## Post-review fix (2026-10-03)

The headline finding (journal balance fails for negative components) is
**fixed at ingestion**. `summarizeTransactions()` in `src/reconcile.js`
now normalizes every amount/fee with `Math.abs` per bucket, matching how
real Stripe balance transactions are signed (refund/chargeback amounts
negative; fees negative on fee returns) and establishing exactly the
hypotheses `0 ≤ fees ∧ 0 ≤ refunds ∧ 0 ≤ chargebacks` under which
`journal_balances` is proved. `hasChargeback` can no longer be flipped
off by signed input, so a chargeback payout is always an exception.
Behavior on the previous positive-magnitude convention (sample data,
existing tests) is unchanged. Three regression tests in
`test/reconcile.test.js` cover signed normalization, the Lean
counterexample itself (fees = −100, mismatch 0), and a signed chargeback
payout end-to-end (10/10 tests pass; demo unchanged).
