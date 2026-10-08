import { caps, readLedger } from "./guardrails.js";
import { monthKey } from "./util.js";

export async function cmdSpend(args: { month?: string }): Promise<void> {
  const month = args.month && /^\d{4}-\d{2}$/.test(args.month) ? args.month : monthKey();
  const ledger = await readLedger(month);
  const c = caps();
  const lines = [
    `month ${month}: $${ledger.totalUsd.toFixed(4)} of $${c.monthCapUsd} cap, ${ledger.calls} calls, ${Object.keys(ledger.runs).length} run(s)`,
  ];
  for (const [runId, r] of Object.entries(ledger.runs).sort()) {
    lines.push(`  ${runId}: $${r.costUsd.toFixed(4)} ${r.calls} calls (${Object.keys(r.perCandidate).length} candidates)`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}
