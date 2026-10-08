import path from "node:path";
import type { RunRecord } from "./types.js";
import { cmdAggregate } from "./aggregate.js";
import { cmdCandidate } from "./candidate.js";
import { cmdFetch } from "./fetch.js";
import { fromRepo } from "./paths.js";
import { exists, limiter, log, stamp } from "./util.js";

export interface RedesignArgs {
  run?: string;
  candidates: number;
  rounds: number;
  parallel: number;
  data?: string;
}

/** Local all-in-one: candidates (sequential or --parallel N) then aggregate. */
export async function cmdRedesign(args: RedesignArgs): Promise<RunRecord> {
  const runId = args.run ?? stamp();
  const data = args.data ?? "data/latest.json";
  const dataAbs = path.isAbsolute(data) ? data : fromRepo(data);
  if (!exists(dataAbs)) {
    log(`${dataAbs} missing; fetching`);
    await cmdFetch({ out: dataAbs });
  }
  const run = limiter(Math.max(1, args.parallel));
  log(`redesign ${runId}: ${args.candidates} candidates x ${args.rounds} rounds, parallel ${args.parallel}`);
  await Promise.all(
    Array.from({ length: args.candidates }, (_, n) =>
      run(async () => {
        try {
          await cmdCandidate({
            n,
            run: runId,
            data: dataAbs,
            rounds: args.rounds,
            out: fromRepo("runs", runId, `cand-${n}.json`),
            candidates: args.candidates,
          });
        } catch (e) {
          log(`candidate ${n} crashed: ${String((e as Error).stack ?? e)}`);
        }
      }),
    ),
  );
  return cmdAggregate({ run: runId });
}
