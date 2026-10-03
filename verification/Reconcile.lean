/-
  Reconcile.lean — a Lean 4 formal model of the stripe-qbo-reconciler
  payout reconciliation engine (src/reconcile.js) and its journal export
  invariants (src/journal.js).

  Core library only: no Mathlib, no `sorry`/`admit`, no custom axioms.
  Compile with plain `lean Reconcile.lean` (Lean 4.34.1).

  All money is `Int` (cents), mirroring the JS: "All money is integer
  cents internally" (reconcile.js, header comment).

  Source map (details in NOTES.md):
    * `Summary`, `computedNet`, `mismatch`  — reconcile.js ll. 31–48, 115
    * `bookingLines`                        — reconcile.js ll. 50–69
    * `eligible`, `findFirst`, `matchAll`   — reconcile.js ll. 108–134
    * `needsReview`, `status`               — reconcile.js ll. 140–177
-/

namespace Reconcile

/-! ## 1. Per-payout summary and payout footing

    Models `summarizeTransactions` (reconcile.js ll. 31–48) at the level of
    its final result: the JS folds chargeback fees into `fees`
    (`s.fees += s.chargebackFees`, l. 45) before forming `computedNet`
    (l. 46), so the model keeps only the four final fields. -/

/-- Final per-payout summary of grouped Stripe balance transactions. -/
structure Summary where
  gross : Int
  fees : Int
  refunds : Int
  chargebacks : Int

/-- reconcile.js l. 46: `computedNet = gross - fees - refunds - chargebacks`. -/
def computedNet (s : Summary) : Int :=
  s.gross - s.fees - s.refunds - s.chargebacks

/-- reconcile.js l. 115: `mismatchCents = payout.amount - s.computedNet`. -/
def mismatch (amount : Int) (s : Summary) : Int :=
  amount - computedNet s

/-! ## 2. Booking lines and the journal balance invariant

    Models `bookingLines(payout, s, mismatchCents)` (reconcile.js
    ll. 50–69) as a list of `(account, debit, credit)` triples, in the same
    order and with the same guards as the JS. Account names are the exact
    strings of `ACCOUNTS` (reconcile.js ll. 14–21). -/

def acctBankClearing : String := "Bank Clearing — Stripe Payouts"
def acctSalesRevenue : String := "Sales Revenue"
def acctStripeFees : String := "Stripe Processing Fees"
def acctRefunds : String := "Refunds (Contra Revenue)"
def acctChargebacks : String := "Chargebacks (Contra Revenue)"
def acctSuspense : String := "Unreconciled Difference (Suspense)"

/-- The journal lines for one payout.

    Mirrors the JS exactly, including the guards:
    * bank clearing debit of the full payout amount — always (l. 58);
    * fees / refunds / chargebacks debits — only when the component
      is `> 0` (ll. 59–61);
    * gross sales credit — always (l. 62);
    * suspense credit of `mismatch` when `mismatch > 0` (l. 65);
    * suspense debit of `-mismatch` when `mismatch < 0` (l. 66). -/
def bookingLines (amount : Int) (s : Summary) : List (String × Int × Int) :=
  [(acctBankClearing, amount, 0)]
    ++ (if 0 < s.fees then [(acctStripeFees, s.fees, 0)] else [])
    ++ (if 0 < s.refunds then [(acctRefunds, s.refunds, 0)] else [])
    ++ (if 0 < s.chargebacks then [(acctChargebacks, s.chargebacks, 0)] else [])
    ++ [(acctSalesRevenue, 0, s.gross)]
    ++ (if 0 < mismatch amount s
        then [(acctSuspense, 0, mismatch amount s)] else [])
    ++ (if mismatch amount s < 0
        then [(acctSuspense, - mismatch amount s, 0)] else [])

/-- Sum of the debit column (the `debitCents` of `journalTotals`,
    journal.js ll. 41–52, before its dollar round-trip). -/
def totalDebit (lines : List (String × Int × Int)) : Int :=
  (lines.map fun l => l.2.1).sum

/-- Sum of the credit column. -/
def totalCredit (lines : List (String × Int × Int)) : Int :=
  (lines.map fun l => l.2.2).sum

/-- **(a) The journal always balances** — under one load-bearing hypothesis.

    For every payout amount and summary whose fee/refund/chargeback
    components are nonnegative, total debits equal total credits.

    The nonnegativity hypotheses cannot be dropped: if e.g. `fees < 0`,
    the guarded fee line is omitted from the journal, yet `computedNet`
    still subtracts the (negative) fee, and the suspense line — which only
    ever compensates `amount - computedNet` — cannot make up the
    difference. The identity then fails by exactly the negative component.
    See NOTES.md, discrepancy 1. -/
theorem journal_balances (amount : Int) (s : Summary)
    (hf : 0 ≤ s.fees) (hr : 0 ≤ s.refunds) (hc : 0 ≤ s.chargebacks) :
    totalDebit (bookingLines amount s) = totalCredit (bookingLines amount s) := by
  have hm : mismatch amount s
      = amount - (s.gross - s.fees - s.refunds - s.chargebacks) := rfl
  by_cases h1 : 0 < s.fees <;> by_cases h2 : 0 < s.refunds <;>
    by_cases h3 : 0 < s.chargebacks <;> by_cases h4 : 0 < mismatch amount s <;>
    by_cases h5 : mismatch amount s < 0 <;>
      simp only [bookingLines, totalDebit, totalCredit,
        h1, h2, h3, h4, h5, List.map_append, List.sum_append, List.map_cons,
        List.map_nil, List.sum_cons, List.sum_nil, ite_true, ite_false] <;> omega

/-! ## 3. Deposit matching state machine

    Models the matching loop of `reconcile` (reconcile.js ll. 108–134):
    payouts are processed in the given list order (the JS first sorts by
    date string, l. 108), and each payout greedily takes the first deposit
    (in array order) that is eligible. `used` threads the set of consumed
    deposit ids (`usedDeposits`, l. 106).

    `dayDiff` (reconcile.js l. 29) is abstracted as an arbitrary function
    `dd : Payout → Deposit → Int`; the window constant is
    `DEPOSIT_WINDOW_DAYS = 3` (l. 14). -/

/-- A Stripe payout (only the fields matching looks at, plus `id`). -/
structure Payout where
  id : Int
  amount : Int

/-- A bank deposit. -/
structure Deposit where
  id : Int
  amount : Int

/-- Eligibility of a deposit for a payout (reconcile.js ll. 127–133):
    not already used, exact amount, and day difference within `[0, 3]`. -/
def eligible (dd : Payout → Deposit → Int) (used : List Int) (p : Payout)
    (d : Deposit) : Bool :=
  decide (d.id ∉ used ∧ d.amount = p.amount ∧ 0 ≤ dd p d ∧ dd p d ≤ 3)

theorem eligible_eq_true_iff {dd : Payout → Deposit → Int} {used : List Int}
    {p : Payout} {d : Deposit} :
    eligible dd used p d = true ↔
      d.id ∉ used ∧ d.amount = p.amount ∧ 0 ≤ dd p d ∧ dd p d ≤ 3 := by
  simp [eligible]

/-- First-fit scan of the deposits array (reconcile.js ll. 127–133):
    the first eligible deposit wins; array order is significant. -/
def findFirst (dd : Payout → Deposit → Int) (used : List Int) (p : Payout) :
    List Deposit → Option Deposit
  | [] => none
  | d :: ds =>
      match eligible dd used p d with
      | true => some d
      | false => findFirst dd used p ds

/-- A successful first-fit scan returns a member of the deposits list that
    is eligible against the used-set at scan time. -/
theorem findFirst_eq_some {dd : Payout → Deposit → Int} {used : List Int}
    {p : Payout} {ds : List Deposit} {d : Deposit}
    (h : findFirst dd used p ds = some d) :
    d ∈ ds ∧ eligible dd used p d = true := by
  induction ds with
  | nil => simp [findFirst] at h
  | cons d' ds ih =>
      cases he : eligible dd used p d'
      · have h' : findFirst dd used p (d' :: ds) = findFirst dd used p ds := by
          simp [findFirst, he]
        rw [h'] at h
        obtain ⟨hmem, hel⟩ := ih h
        exact ⟨List.mem_cons_of_mem d' hmem, hel⟩
      · have h' : findFirst dd used p (d' :: ds) = some d' := by
          simp [findFirst, he]
        rw [h'] at h
        cases h
        exact ⟨List.mem_cons_self, he⟩

/-- The matching loop: process payouts in order, threading used deposit ids.
    Returns the list of matched `(payout, deposit)` pairs. -/
def matchAll (dd : Payout → Deposit → Int) (deposits : List Deposit) :
    List Int → List Payout → List (Payout × Deposit)
  | _, [] => []
  | used, p :: ps =>
      match findFirst dd used p deposits with
      | some d => (p, d) :: matchAll dd deposits (d.id :: used) ps
      | none => matchAll dd deposits used ps

/-- The deposit ids matched by a run, in payout order. -/
def matchedDepositIds (pairs : List (Payout × Deposit)) : List Int :=
  pairs.map fun pr => pr.2.id

/-- Invariant behind **(b)**: every matched deposit id is fresh w.r.t. the
    incoming used-set, and the matched ids are pairwise distinct. -/
theorem matchAll_fresh_and_nodup (dd : Payout → Deposit → Int)
    (deposits : List Deposit) (used : List Int) :
    ∀ ps : List Payout,
      (∀ pr ∈ matchAll dd deposits used ps, pr.2.id ∉ used) ∧
      List.Nodup (matchedDepositIds (matchAll dd deposits used ps)) := by
  intro ps
  induction ps generalizing used with
  | nil => simp [matchAll, matchedDepositIds]
  | cons p ps ih =>
      cases h : findFirst dd used p deposits with
      | none =>
          have h' : matchAll dd deposits used (p :: ps)
              = matchAll dd deposits used ps := by
            simp [matchAll, h]
          rw [h']
          exact ih used
      | some d =>
          have h' : matchAll dd deposits used (p :: ps)
              = (p, d) :: matchAll dd deposits (d.id :: used) ps := by
            simp [matchAll, h]
          rw [h']
          obtain ⟨-, hdel⟩ := findFirst_eq_some h
          have hdfresh : d.id ∉ used := (eligible_eq_true_iff.mp hdel).1
          obtain ⟨ihfresh, ihnodup⟩ := ih (d.id :: used)
          constructor
          · intro pr hpr
            rcases List.mem_cons.mp hpr with rfl | htail
            · exact hdfresh
            · have hni := ihfresh pr htail
              intro hcon
              exact hni (List.mem_cons.mpr (Or.inr hcon))
          · rw [matchedDepositIds, List.map_cons]
            rw [List.nodup_cons]
            constructor
            · intro hcon
              obtain ⟨pr, hpr, hid⟩ := List.mem_map.mp hcon
              exact ihfresh pr hpr (List.mem_cons.mpr (Or.inl hid))
            · exact ihnodup

/-- The full run, starting from the empty used-set (`usedDeposits` starts
    empty, reconcile.js l. 106). -/
def matchDeposits (dd : Payout → Deposit → Int) (deposits : List Deposit)
    (ps : List Payout) : List (Payout × Deposit) :=
  matchAll dd deposits [] ps

/-- **(b) Injectivity**: no bank deposit is ever matched to two payouts —
    the matched deposit ids are pairwise distinct. -/
theorem no_deposit_matched_twice (dd : Payout → Deposit → Int)
    (deposits : List Deposit) (ps : List Payout) :
    List.Nodup (matchedDepositIds (matchDeposits dd deposits ps)) :=
  (matchAll_fresh_and_nodup dd deposits [] ps).2

/-- **(c)** Every matched pair satisfies the eligibility conditions of
    reconcile.js ll. 127–133: the deposit comes from the deposits list, its
    amount equals the payout amount, and the day difference lies in
    `[0, DEPOSIT_WINDOW_DAYS]`. -/
theorem matchAll_pairs_eligible (dd : Payout → Deposit → Int)
    (deposits : List Deposit) (used : List Int) :
    ∀ ps : List Payout, ∀ pr ∈ matchAll dd deposits used ps,
      pr.2 ∈ deposits ∧ pr.2.amount = pr.1.amount ∧
      0 ≤ dd pr.1 pr.2 ∧ dd pr.1 pr.2 ≤ 3 := by
  intro ps
  induction ps generalizing used with
  | nil => intro pr hpr; simp [matchAll] at hpr
  | cons p ps ih =>
      intro pr hpr
      cases h : findFirst dd used p deposits with
      | none =>
          have h' : matchAll dd deposits used (p :: ps)
              = matchAll dd deposits used ps := by
            simp [matchAll, h]
          rw [h'] at hpr
          exact ih used pr hpr
      | some d =>
          have h' : matchAll dd deposits used (p :: ps)
              = (p, d) :: matchAll dd deposits (d.id :: used) ps := by
            simp [matchAll, h]
          rw [h'] at hpr
          obtain ⟨hdmem, hdel⟩ := findFirst_eq_some h
          have hel := eligible_eq_true_iff.mp hdel
          rcases List.mem_cons.mp hpr with rfl | htail
          · exact ⟨hdmem, hel.2.1, hel.2.2.1, hel.2.2.2⟩
          · exact ih (d.id :: used) pr htail

/-- **(c)** for the full run from the empty used-set. -/
theorem matched_pairs_satisfy_eligibility (dd : Payout → Deposit → Int)
    (deposits : List Deposit) (ps : List Payout) :
    ∀ pr ∈ matchDeposits dd deposits ps,
      pr.2 ∈ deposits ∧ pr.2.amount = pr.1.amount ∧
      0 ≤ dd pr.1 pr.2 ∧ dd pr.1 pr.2 ≤ 3 :=
  matchAll_pairs_eligible dd deposits [] ps

/-! ## 4. Status classification

    Models the `needsReview` test and status assignment of `reconcile`
    (reconcile.js ll. 140–177): a result starts as `"matched"` (l. 152) and
    is overwritten with `"exception"` iff `needsReview` holds
    (ll. 156–157, 175). The provider classification that then runs only
    attaches a category/reason; it never changes the status back. -/

inductive Status where
  | matched
  | exception
  deriving DecidableEq, Repr

/-- reconcile.js ll. 156–157:
    `mismatchCents !== 0 || !deposit || duplicateChargeCount > 0 || hasChargeback`.
    Here `depositMatched` stands for `Boolean(deposit)` (l. 142). -/
def needsReview (mismatchCents : Int) (depositMatched : Bool)
    (duplicateChargeCount : Int) (hasChargeback : Bool) : Prop :=
  mismatchCents ≠ 0 ∨ depositMatched = false ∨
    0 < duplicateChargeCount ∨ hasChargeback = true

instance (m : Int) (d : Bool) (c : Int) (b : Bool) :
    Decidable (needsReview m d c b) :=
  inferInstanceAs (Decidable (m ≠ 0 ∨ d = false ∨ 0 < c ∨ b = true))

/-- The status a payout ends with. -/
def status (mismatchCents : Int) (depositMatched : Bool)
    (duplicateChargeCount : Int) (hasChargeback : Bool) : Status :=
  if needsReview mismatchCents depositMatched duplicateChargeCount hasChargeback
    then Status.exception
    else Status.matched

/-- **(d)** A payout is auto-matched iff it does *not* need review. -/
theorem status_matched_iff_not_needsReview {m : Int} {d : Bool} {c : Int}
    {b : Bool} :
    status m d c b = Status.matched ↔ ¬ needsReview m d c b := by
  by_cases h : needsReview m d c b
  · have hst : status m d c b = Status.exception := by
      unfold status
      exact ite_eq_left h ▸ rfl
    rw [hst]
    exact ⟨fun he => Status.noConfusion he, fun hn => (hn h).elim⟩
  · have hst : status m d c b = Status.matched := by
      unfold status
      exact ite_eq_right h ▸ rfl
    rw [hst]
    exact ⟨fun _ => h, fun _ => rfl⟩

/-- **(d′)** … i.e. iff all four review conditions are simultaneously clean:
    the payout foots exactly, a deposit was matched, there are no duplicate
    charges, and there is no chargeback. -/
theorem status_matched_iff_clean {m : Int} {d : Bool} {c : Int} {b : Bool} :
    status m d c b = Status.matched ↔
      m = 0 ∧ d = true ∧ c ≤ 0 ∧ b = false := by
  rw [status_matched_iff_not_needsReview]
  constructor
  · intro h
    have h' : ¬ (m ≠ 0 ∨ d = false ∨ 0 < c ∨ b = true) := h
    rw [not_or, not_or, not_or] at h'
    obtain ⟨hm, hd, hc, hb⟩ := h'
    refine ⟨by omega, ?_, by omega, ?_⟩
    · cases d with
      | false => exact absurd rfl hd
      | true => rfl
    · cases b with
      | true => exact absurd rfl hb
      | false => rfl
  · intro hclean h
    obtain ⟨hm, hd, hc, hb⟩ := hclean
    cases h with
    | inl h => exact h hm
    | inr h =>
        cases h with
        | inl h => rw [hd] at h; exact Bool.noConfusion h
        | inr h =>
            cases h with
            | inl h => omega
            | inr h => rw [hb] at h; exact Bool.noConfusion h

/-- **(e)** A payout that does not foot (`mismatch ≠ 0`) is never
    auto-matched, no matter how clean everything else is. -/
theorem mismatch_ne_zero_status_exception {m : Int} {d : Bool} {c : Int}
    {b : Bool} (hm : m ≠ 0) :
    status m d c b = Status.exception := by
  unfold status
  exact ite_eq_left (Or.inl hm) ▸ rfl

end Reconcile
