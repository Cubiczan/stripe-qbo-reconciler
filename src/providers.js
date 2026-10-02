// Exception classification behind a small DecisionProvider interface.
//
// Two implementations:
//   - JevProvider: calls TypeSafe AI's Jev "System One" model
//     (POST https://api.typesafe.ai/v1/systemone, model "jev-latest") and asks
//     three typed questions in a single parallel call:
//       * choice "category"     -> fee_mismatch | refund_timing | chargeback |
//                                  possible_duplicate | missing_deposit | other
//       * noul   "is_duplicate" -> probability the payout is a duplicate
//       * score  "anomaly_risk" -> 1 (routine) .. 5 (severe) rubric
//     Used only when JEV_API_KEY is set in the environment. The key is never
//     printed or logged.
//   - RulesProvider: deterministic, offline rules. This is the default, and
//     also the fallback if a Jev call fails.
//
// A classification context is a plain object of reconciliation signals:
//   { payoutId, amountMismatchCents, hasChargeback, duplicateChargeCount,
//     depositMatched, hasRefunds, mismatchEqualsRefundAmount,
//     grossCents, computedNetCents }

export const CATEGORIES = [
  "fee_mismatch",
  "refund_timing",
  "chargeback",
  "possible_duplicate",
  "missing_deposit",
  "other",
];

export class RulesProvider {
  constructor() {
    this.name = "rules";
  }

  async classify(ctx) {
    if (ctx.duplicateChargeCount > 0) {
      return {
        category: "possible_duplicate",
        isDuplicate: true,
        duplicateProbability: 1,
        anomalyRisk: 4,
        source: this.name,
      };
    }
    if (!ctx.depositMatched) {
      return {
        category: "missing_deposit",
        isDuplicate: false,
        duplicateProbability: 0,
        anomalyRisk: ctx.computedNetCents >= 100000 ? 4 : 3,
        source: this.name,
      };
    }
    if (ctx.amountMismatchCents !== 0) {
      if (ctx.mismatchEqualsRefundAmount) {
        return {
          category: "refund_timing",
          isDuplicate: false,
          duplicateProbability: 0,
          anomalyRisk: 2,
          source: this.name,
        };
      }
      const abs = Math.abs(ctx.amountMismatchCents);
      return {
        category: "fee_mismatch",
        isDuplicate: false,
        duplicateProbability: 0,
        anomalyRisk: abs >= 5000 ? 4 : abs >= 500 ? 3 : 2,
        source: this.name,
      };
    }
    if (ctx.hasChargeback) {
      return {
        category: "chargeback",
        isDuplicate: false,
        duplicateProbability: 0,
        anomalyRisk: 3,
        source: this.name,
      };
    }
    return {
      category: "other",
      isDuplicate: false,
      duplicateProbability: 0,
      anomalyRisk: 2,
      source: this.name,
    };
  }
}

export class JevProvider {
  constructor(apiKey, fetchImpl = globalThis.fetch) {
    if (!apiKey) throw new Error("JevProvider requires an API key");
    this.name = "jev";
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async classify(ctx) {
    const state = {
      payout_id: ctx.payoutId,
      amount_mismatch_cents: ctx.amountMismatchCents,
      has_chargeback: ctx.hasChargeback,
      duplicate_charge_count: ctx.duplicateChargeCount,
      deposit_matched: ctx.depositMatched,
      has_refunds: ctx.hasRefunds,
      mismatch_equals_a_refund_amount: ctx.mismatchEqualsRefundAmount,
      gross_cents: ctx.grossCents,
      computed_net_cents: ctx.computedNetCents,
    };
    const questions = {
      category: {
        type: "choice",
        instructions:
          "Classify the single most likely root cause of this Stripe payout reconciliation exception.",
        criteria: {
          fee_mismatch:
            "The payout amount differs from gross minus recorded fees/refunds, suggesting an unrecorded or incorrect processing fee or adjustment.",
          refund_timing:
            "The difference equals a refund amount, suggesting a refund settled in a different payout period than expected.",
          chargeback:
            "The payout contains a cardholder chargeback/dispute that needs human review before booking.",
          possible_duplicate:
            "The same underlying charges appear in more than one payout, suggesting duplicated data or a double payout.",
          missing_deposit:
            "The payout reconciles internally but no matching bank deposit was found.",
          other: "None of the above describes this exception.",
        },
      },
      is_duplicate: {
        type: "noul",
        instructions: "Is this payout a duplicate of another payout?",
        criteria: {
          true: "The same underlying charges appear in another payout as well.",
          false: "All underlying charges are unique to this payout.",
        },
      },
      anomaly_risk: {
        type: "score",
        instructions:
          "Rate how anomalous and financially risky this exception is for the books.",
        criteria: [
          "1 - Routine timing difference, no revenue impact.",
          "2 - Minor discrepancy, small dollar amount, easily explained.",
          "3 - Needs review: chargeback or moderate unexplained difference.",
          "4 - Serious: large unexplained difference, missing money, or duplicated charges.",
          "5 - Severe: likely double-counted revenue or lost funds requiring immediate action.",
        ],
      },
    };

    const res = await this.fetchImpl("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: JSON.stringify(state),
        questions,
      }),
    });
    if (!res.ok) throw new Error(`Jev API request failed with status ${res.status}`);
    const data = await res.json();
    const answers = data.answers ?? {};
    const duplicateProbability =
      typeof answers.is_duplicate?.noul === "number" ? answers.is_duplicate.noul : null;
    const rawScore = answers.anomaly_risk?.score;
    return {
      category: CATEGORIES.includes(answers.category?.choice)
        ? answers.category.choice
        : "other",
      isDuplicate: duplicateProbability !== null ? duplicateProbability >= 0.5 : false,
      duplicateProbability,
      anomalyRisk:
        typeof rawScore === "number" ? Math.min(5, Math.max(1, Math.round(rawScore))) : null,
      confidence: answers.category?.confidence ?? null,
      source: this.name,
    };
  }
}

// Default: Jev when JEV_API_KEY is present, otherwise the rules provider.
export function createProvider(env = process.env) {
  if (env.JEV_API_KEY) return new JevProvider(env.JEV_API_KEY);
  return new RulesProvider();
}
