import { parseArgs } from "node:util";
import { checkKillSwitchOrExit, redact } from "./guardrails.js";
import { envInt, log } from "./util.js";

const USAGE = `usage: npm run cli -- <command> [options]

  fetch      --out data/latest.json [--cache orchestrator/.cache/items]
  candidate  --n <i> --run <runId> [--data data/latest.json] [--rounds 10] [--out runs/<runId>/cand-<i>.json] [--candidates 16]
  tier2      --site out/ --out report.json [--all-pages]
  judge      --site out/ --out judge.json [--shots <dir>]
  aggregate  --run <runId> [--dir runs/<runId>/] [--no-release]
  release    --from runs/<runId>/cand-<i>.json
  rollback   <releaseId>
  readme     (rewrite the generation section of README.md from releases/index.json)
  site-extras --out out/   (feed.xml, sitemap.xml, preview.png next to the rendered site)
  redesign   [--run <runId>] [--candidates 16] [--rounds 10] [--parallel 1] [--data data/latest.json]
  spend      [--month [YYYY-MM]]

Every command exits 0 with "paused" when KILL_SWITCH exists at the repo root.
See orchestrator/README.md for environment variables.
`;

function num(v: string | undefined, def: number, name: string): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }
  checkKillSwitchOrExit();

  switch (cmd) {
    case "fetch": {
      const { values } = parseArgs({ args: rest, options: { out: { type: "string" }, cache: { type: "string" } } });
      const { cmdFetch } = await import("./fetch.js");
      await cmdFetch({ out: values.out ?? "data/latest.json", cache: values.cache });
      return 0;
    }
    case "candidate": {
      const { values } = parseArgs({
        args: rest,
        options: {
          n: { type: "string" },
          run: { type: "string" },
          data: { type: "string" },
          rounds: { type: "string" },
          out: { type: "string" },
          candidates: { type: "string" },
        },
      });
      if (values.n === undefined || !values.run) throw new Error("candidate: --n and --run are required");
      const n = num(values.n, 0, "n");
      const { cmdCandidate } = await import("./candidate.js");
      const rec = await cmdCandidate({
        n,
        run: values.run,
        data: values.data ?? "data/latest.json",
        rounds: num(values.rounds, 10, "rounds"),
        out: values.out ?? `runs/${values.run}/cand-${n}.json`,
        candidates: num(values.candidates, envInt("CANDIDATES", 16), "candidates"),
      });
      // Exit 0 regardless of pass/fail: the record is the result. Non-zero only on crash.
      return rec.stopReason === "error" ? 1 : 0;
    }
    case "tier2": {
      const { values } = parseArgs({
        args: rest,
        options: { site: { type: "string" }, out: { type: "string" }, "all-pages": { type: "boolean" } },
      });
      if (!values.site) throw new Error("tier2: --site is required");
      const { cmdTier2 } = await import("./tier2.js");
      const r = await cmdTier2({ site: values.site, out: values.out ?? "report.json", allPages: values["all-pages"] });
      return r.ok ? 0 : 1;
    }
    case "judge": {
      const { values } = parseArgs({
        args: rest,
        options: { site: { type: "string" }, out: { type: "string" }, shots: { type: "string" } },
      });
      if (!values.site) throw new Error("judge: --site is required");
      const { cmdJudge } = await import("./judge.js");
      await cmdJudge({ site: values.site, out: values.out ?? "judge.json", shots: values.shots });
      return 0;
    }
    case "aggregate": {
      const { values } = parseArgs({
        args: rest,
        options: { run: { type: "string" }, dir: { type: "string" }, "no-release": { type: "boolean" } },
      });
      if (!values.run) throw new Error("aggregate: --run is required");
      const { cmdAggregate } = await import("./aggregate.js");
      await cmdAggregate({ run: values.run, dir: values.dir, noRelease: values["no-release"] });
      return 0;
    }
    case "release": {
      const { values } = parseArgs({ args: rest, options: { from: { type: "string" } } });
      if (!values.from) throw new Error("release: --from is required");
      const { cmdRelease } = await import("./release.js");
      await cmdRelease({ from: values.from });
      return 0;
    }
    case "readme": {
      const { readReleasesIndex } = await import("./release.js");
      const { updateReadme } = await import("./readme.js");
      const changed = await updateReadme(await readReleasesIndex());
      process.stdout.write(changed ? "README.md generation section updated\n" : "README.md unchanged\n");
      return 0;
    }
    case "site-extras": {
      const { values } = parseArgs({ args: rest, options: { out: { type: "string" } } });
      if (!values.out) throw new Error("site-extras: --out is required");
      const { readReleasesIndex } = await import("./release.js");
      const { writeSiteExtras } = await import("./siteExtras.js");
      const written = await writeSiteExtras(values.out, await readReleasesIndex());
      process.stdout.write(`site-extras\n${written.map((p) => `  ${p}`).join("\n")}\n`);
      return 0;
    }
    case "rollback": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const id = positionals[0];
      if (!id) throw new Error("rollback: <releaseId> is required");
      const { cmdRollback } = await import("./release.js");
      await cmdRollback(id);
      return 0;
    }
    case "redesign": {
      const { values } = parseArgs({
        args: rest,
        options: {
          run: { type: "string" },
          candidates: { type: "string" },
          rounds: { type: "string" },
          parallel: { type: "string" },
          data: { type: "string" },
        },
      });
      const { cmdRedesign } = await import("./redesign.js");
      await cmdRedesign({
        run: values.run,
        candidates: num(values.candidates, 16, "candidates"),
        rounds: num(values.rounds, 10, "rounds"),
        parallel: num(values.parallel, 1, "parallel"),
        data: values.data,
      });
      return 0;
    }
    case "spend": {
      // `spend --month` (current month) or `spend --month 2026-10`.
      const { values, positionals } = parseArgs({ args: rest, options: { month: { type: "boolean" } }, allowPositionals: true });
      const { cmdSpend } = await import("./spend.js");
      await cmdSpend({ month: values.month ? positionals[0] : undefined });
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    log(`error: ${redact(String((err as Error).stack ?? err))}`);
    process.exit(1);
  },
);
