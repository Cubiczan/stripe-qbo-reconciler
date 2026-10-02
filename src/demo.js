// Demo: run the full pipeline on the sample month, write the QuickBooks
// journal exports, and print a summary.
//
//   npm run demo
//
// Uses Jev for exception classification when JEV_API_KEY is set in the
// environment; otherwise the deterministic rules provider (the default).
// No Stripe or QuickBooks credentials are needed — everything runs on the
// synthetic data in data/sample/ (generated on first run).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSampleData } from "./generate-sample.js";
import { reconcile } from "./reconcile.js";
import { createProvider } from "./providers.js";
import { buildJournal, journalToCsv, journalTotals } from "./journal.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sampleDir = join(root, "data", "sample");
const exportDir = join(root, "data", "exports");

function loadSample() {
  const payoutsPath = join(sampleDir, "stripe-payouts.json");
  if (!existsSync(payoutsPath)) {
    const data = generateSampleData();
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(payoutsPath, JSON.stringify(data.payouts, null, 2));
    writeFileSync(join(sampleDir, "balance-transactions.json"), JSON.stringify(data.transactions, null, 2));
    writeFileSync(join(sampleDir, "bank-deposits.json"), JSON.stringify(data.deposits, null, 2));
    writeFileSync(join(sampleDir, "ground-truth.json"), JSON.stringify(data.groundTruth, null, 2));
    return data;
  }
  return {
    payouts: JSON.parse(readFileSync(payoutsPath, "utf8")),
    transactions: JSON.parse(readFileSync(join(sampleDir, "balance-transactions.json"), "utf8")),
    deposits: JSON.parse(readFileSync(join(sampleDir, "bank-deposits.json"), "utf8")),
  };
}

// Manual baseline: sellers report ~10 hours/month hand-matching Stripe
// payouts into QuickBooks. Assume each remaining exception takes ~15
// minutes of human review; everything auto-matched takes none.
const MANUAL_BASELINE_HOURS = 10;
const REVIEW_MINUTES_PER_EXCEPTION = 15;

const money = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

async function main() {
  const { payouts, transactions, deposits } = loadSample();
  const provider = createProvider();
  const { results, summary } = await reconcile({ payouts, transactions, deposits }, provider);

  mkdirSync(exportDir, { recursive: true });
  const journal = buildJournal(results);
  writeFileSync(join(exportDir, "journal-entries.json"), JSON.stringify(journal, null, 2));
  writeFileSync(join(exportDir, "journal-entries.csv"), journalToCsv(journal));
  const totals = journalTotals(journal);

  const exceptions = results.filter((r) => r.status === "exception");
  const reviewHours = (exceptions.length * REVIEW_MINUTES_PER_EXCEPTION) / 60;
  const hoursSaved = Math.max(0, MANUAL_BASELINE_HOURS - reviewHours);

  console.log("Stripe → QuickBooks Payout Reconciler — September 2026 (sample data)");
  console.log("=".repeat(72));
  console.log(`Payouts processed:      ${summary.payoutCount}`);
  console.log(`Gross sales:            ${money(summary.totals.gross)}`);
  console.log(`Stripe fees:            ${money(summary.totals.fees)}`);
  console.log(`Refunds:                ${money(summary.totals.refunds)}`);
  console.log(`Chargebacks:            ${money(summary.totals.chargebacks)}`);
  console.log(`Net paid out:           ${money(summary.totals.net)}`);
  console.log(
    `Auto-matched:           ${summary.matchedCount}/${summary.payoutCount} (${summary.autoMatchPct.toFixed(0)}%)`
  );
  console.log(`Decision provider:      ${provider.name}${provider.name === "jev" ? " (JEV_API_KEY detected)" : " (default; set JEV_API_KEY to use Jev)"}`);
  console.log("");
  if (exceptions.length) {
    console.log(`Exceptions (${exceptions.length}) — need human review:`);
    for (const e of exceptions) {
      const c = e.classification;
      console.log(
        `  - ${e.payoutId} · ${c?.category ?? "review"} · anomaly risk ${c?.anomalyRisk ?? "?"}/5 · ${e.reason}`
      );
    }
    console.log("");
  }
  console.log(
    `Journal export:         data/exports/journal-entries.json + .csv (${journal.length} entries, debits ${money(totals.debitCents)} = credits ${money(totals.creditCents)})`
  );
  console.log(
    `Estimated time saved:   ~${hoursSaved.toFixed(1)} of the ~${MANUAL_BASELINE_HOURS} hrs/month sellers spend hand-matching ` +
      `(${exceptions.length} exceptions × ~${REVIEW_MINUTES_PER_EXCEPTION} min review)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
