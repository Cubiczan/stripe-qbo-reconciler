// QuickBooks-ready journal export.
//
// One journal entry per payout. Money leaves this module in dollars
// (converted from integer cents) — the shape QBO journal imports expect:
// separate lines for gross revenue, processing fees, refunds
// contra-revenue, chargebacks, and the bank clearing account. Entries
// always balance: any payout that does not foot carries an explicit
// "Unreconciled Difference (Suspense)" line (see reconcile.js).

const dollars = (cents) => Math.round(cents) / 100;
const fmt = (cents) => (cents / 100).toFixed(2);

export function buildJournal(reconcileResults) {
  return reconcileResults.map((r, i) => ({
    txnDate: r.date,
    docNumber: `JE-${String(i + 1).padStart(3, "0")}`,
    journalEntryId: r.payoutId,
    memo:
      r.status === "matched"
        ? `Stripe payout ${r.payoutId} — auto-reconciled`
        : `Stripe payout ${r.payoutId} — EXCEPTION (${r.classification?.category ?? "review"}): ${r.reason}`,
    lines: r.lines.map((l) => ({
      account: l.account,
      debit: dollars(l.debit),
      credit: dollars(l.credit),
      description: l.description,
    })),
  }));
}

export function journalToCsv(entries) {
  const esc = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["TxnDate", "DocNumber", "PayoutId", "Account", "Debit", "Credit", "Description"]];
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push([
        e.txnDate,
        e.docNumber,
        e.journalEntryId,
        l.account,
        l.debit ? fmt(Math.round(l.debit * 100)) : "",
        l.credit ? fmt(Math.round(l.credit * 100)) : "",
        l.description,
      ]);
    }
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

export function journalTotals(entries) {
  let debit = 0;
  let credit = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      debit += Math.round(l.debit * 100);
      credit += Math.round(l.credit * 100);
    }
  }
  return { debitCents: debit, creditCents: credit, balanced: debit === credit };
}
