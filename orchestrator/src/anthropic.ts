import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ORCHESTRATOR_DIR } from "./paths.js";
import type { Budget } from "./guardrails.js";
import { redact } from "./guardrails.js";
import { envInt, envStr, log } from "./util.js";

export const MODEL = envStr("HNFORMAL_MODEL", "claude-haiku-5-5");

/**
 * Claude Haiku 5.5 list prices (USD per MTok), two rate cards selected by
 * prompt length. Cache reads are 0.1x input, 5-minute cache writes 1.25x,
 * 1-hour cache writes 2x. Source: claude-api skill, shared/models.md and
 * shared/model-migration.md ("Migrating to Claude Haiku 5.5").
 */
export const PRICING = {
  tierSplitTokens: 100_000,
  low: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  high: { inputPerMTok: 0.5, outputPerMTok: 2.5 },
  cacheReadMultiplier: 0.1,
  cacheWrite5mMultiplier: 1.25,
  cacheWrite1hMultiplier: 2.0,
} as const;

/** Refuse to start when the cached prefix exceeds this many tokens. */
export const PREFIX_MAX_TOKENS = envInt("PREFIX_MAX_TOKENS", 90_000);
export const PREFIX_WARN_TOKENS = envInt("PREFIX_WARN_TOKENS", 60_000);
/**
 * Output cap per generation call. Haiku 5.5 thinks adaptively by default and
 * the thinking counts against max_tokens, so 32K cut long rounds off mid-file
 * (run 20261009-104231, candidates 8 and 15). The model allows 128K; 64K is
 * at most $0.032 per call on the low rate card.
 */
export const GENERATE_MAX_TOKENS = envInt("GENERATE_MAX_TOKENS", 64_000);
export const CACHE_TTL: "5m" | "1h" = envStr("CACHE_TTL", "1h") === "5m" ? "5m" : "1h";

export const MOCK = process.env.ANTHROPIC_MOCK === "1";

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

export interface CostBreakdown {
  promptTokens: number;
  tier: "low" | "high";
  usd: number;
}

/** Cost of one response from its `usage`, at Haiku 5.5 list prices. */
export function costOf(u: UsageLike): CostBreakdown {
  const read = u.cache_read_input_tokens ?? 0;
  const created = u.cache_creation_input_tokens ?? 0;
  let c5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  let c1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (!u.cache_creation && created > 0) {
    // No breakdown: attribute to the TTL we asked for.
    if (CACHE_TTL === "1h") c1h = created;
    else c5m = created;
  }
  const promptTokens = u.input_tokens + read + created;
  const tier = promptTokens > PRICING.tierSplitTokens ? "high" : "low";
  const rates = PRICING[tier];
  const inRate = rates.inputPerMTok / 1e6;
  const outRate = rates.outputPerMTok / 1e6;
  const usd =
    u.input_tokens * inRate +
    c5m * PRICING.cacheWrite5mMultiplier * inRate +
    c1h * PRICING.cacheWrite1hMultiplier * inRate +
    read * PRICING.cacheReadMultiplier * inRate +
    u.output_tokens * outRate;
  return { promptTokens, tier, usd };
}

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    // Credentials come from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an
    // `ant auth login` profile. Never log them.
    client = new Anthropic({ maxRetries: 3, timeout: 15 * 60 * 1000 });
  }
  return client;
}

/** Probe whether credentials work (free: count_tokens). */
export async function authAvailable(): Promise<boolean> {
  if (MOCK) return false;
  try {
    await getClient().messages.countTokens({
      model: MODEL,
      messages: [{ role: "user", content: "ping" }],
    });
    return true;
  } catch (e) {
    log(`auth probe failed: ${redact(String((e as Error).message ?? e))}`);
    return false;
  }
}

export type SystemBlocks = Anthropic.TextBlockParam[];

/**
 * Count the tokens of the stable prefix once per process; refuse to start if
 * it exceeds PREFIX_MAX_TOKENS.
 */
let prefixCount: number | null = null;
export async function countPrefixTokens(system: SystemBlocks): Promise<number> {
  if (prefixCount !== null) return prefixCount;
  if (MOCK) {
    prefixCount = Math.ceil(system.reduce((a, b) => a + b.text.length, 0) / 3);
  } else {
    const r = await getClient().messages.countTokens({
      model: MODEL,
      system,
      messages: [{ role: "user", content: "." }],
    });
    prefixCount = r.input_tokens;
  }
  if (prefixCount > PREFIX_MAX_TOKENS) {
    throw new Error(
      `cached prefix is ${prefixCount} tokens, above PREFIX_MAX_TOKENS=${PREFIX_MAX_TOKENS}; refusing to start`,
    );
  }
  if (prefixCount > PREFIX_WARN_TOKENS) {
    log(`warning: cached prefix is ${prefixCount} tokens (warn threshold ${PREFIX_WARN_TOKENS}); headroom to the 100K price cliff is thin`);
  } else {
    log(`cached prefix: ${prefixCount} tokens`);
  }
  return prefixCount;
}

export const CandidateOutput = z.object({
  renderLean: z.string().describe("Complete contents of HnFormal/Render.lean"),
  styleCss: z.string().describe("Complete contents of site/style.css"),
  designNotes: z.string().describe("Short notes on the design intent and any proof strategy, for the next repair round"),
});
export type CandidateOutput = z.infer<typeof CandidateOutput>;

export const JudgeOutput = z.object({
  score: z.number().describe("Integer 0-100"),
  notes: z.string().describe("Two to five sentences of concrete observations"),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

export interface CallResult<T> {
  ok: boolean;
  parsed: T | null;
  stopReason: string | null;
  error?: string;
  cost: CostBreakdown;
  usage: UsageLike;
}

function roughTokens(parts: Array<string | { length: number }>): number {
  return Math.ceil(parts.reduce((a, p) => a + (typeof p === "string" ? p.length : p.length), 0) / 3);
}

/**
 * One generation round. Streams, waits for the final message, checks
 * stop_reason, parses structured output. Never throws for model-side
 * failures (refusal, max_tokens, unparseable); throws for transport errors
 * after SDK retries, and for caps (via Budget).
 */
export async function generateCandidate(
  system: SystemBlocks,
  messages: Anthropic.MessageParam[],
  budget: Budget,
): Promise<CallResult<CandidateOutput>> {
  budget.beforeCall();
  if (MOCK) return mockCandidate(budget);

  const prefix = prefixCount ?? (await countPrefixTokens(system));
  const msgChars = JSON.stringify(messages).length;
  const estimate = prefix + Math.ceil(msgChars / 3);
  if (estimate > PRICING.tierSplitTokens && process.env.ALLOW_OVER_100K !== "1") {
    return {
      ok: false,
      parsed: null,
      stopReason: null,
      error: `estimated prompt ${estimate} tokens exceeds the 100K price cliff; set ALLOW_OVER_100K=1 to allow`,
      cost: { promptTokens: 0, tier: "low", usd: 0 },
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: GENERATE_MAX_TOKENS,
    system,
    messages,
    output_config: { format: plainFormat(CandidateOutput), effort: effortFor("GENERATE_EFFORT", "high") },
  });
  const final = await stream.finalMessage();
  const cost = costOf(final.usage);
  budget.record(cost.usd);
  if (cost.tier === "high") log(`warning: prompt was ${cost.promptTokens} tokens, billed on the >100K rate card`);

  if (final.stop_reason === "refusal") {
    const d = final.stop_details;
    return {
      ok: false,
      parsed: null,
      stopReason: "refusal",
      error: `model refused (${d?.category ?? "unknown"}): ${d?.explanation ?? ""}`,
      cost,
      usage: final.usage,
    };
  }
  if (final.stop_reason === "max_tokens") {
    return { ok: false, parsed: null, stopReason: "max_tokens", error: `hit max_tokens=${GENERATE_MAX_TOKENS}`, cost, usage: final.usage };
  }
  const parsed = parseTextJson(final, CandidateOutput);
  if (!parsed) {
    return { ok: false, parsed: null, stopReason: final.stop_reason, error: "structured output did not parse", cost, usage: final.usage };
  }
  return { ok: true, parsed, stopReason: final.stop_reason, cost, usage: final.usage };
}

/**
 * The json_schema output format WITHOUT the SDK's `parse` member. With it
 * present, MessageStream parses the text on message_stop and throws on
 * truncated JSON (a max_tokens response) before stop_reason can be checked
 * and before the call's cost is recorded; that killed candidate 15 of run
 * 20261009-104231 and lost its spend. The schema bytes are unchanged; we
 * parse with zod ourselves after the stop_reason checks.
 */
function plainFormat<T>(schema: z.ZodType<T>): Anthropic.Messages.JSONOutputFormat {
  const { parse: _parse, ...rest } = zodOutputFormat(schema);
  return rest;
}

function parseTextJson<T>(msg: Anthropic.Message, schema: z.ZodType<T>): T | null {
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function effortFor(envName: string, def: "low" | "medium" | "high"): "low" | "medium" | "high" | "xhigh" | "max" {
  const v = process.env[envName];
  if (v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max") return v;
  return def;
}

export interface JudgeImage {
  label: string;
  pngPath: string;
}

/** Vision judge call. Non-streaming structured output (short answer). */
export async function judgeScreens(
  rubric: string,
  images: JudgeImage[],
  budget: Budget,
): Promise<CallResult<JudgeOutput>> {
  budget.beforeCall();
  if (MOCK) return mockJudge(budget);

  const content: Anthropic.ContentBlockParam[] = [];
  for (const im of images) {
    const data = (await fsp.readFile(im.pngPath)).toString("base64");
    content.push({ type: "text", text: im.label });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  }
  content.push({ type: "text", text: "Score the design per the rubric." });

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: "text", text: rubric, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { format: plainFormat(JudgeOutput), effort: effortFor("JUDGE_EFFORT", "low") },
  });
  const cost = costOf(msg.usage);
  budget.record(cost.usd);
  if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
    return { ok: false, parsed: null, stopReason: msg.stop_reason, error: `judge stopped: ${msg.stop_reason}`, cost, usage: msg.usage };
  }
  const parsed = parseTextJson(msg, JudgeOutput);
  if (!parsed) return { ok: false, parsed: null, stopReason: msg.stop_reason, error: "judge output did not parse", cost, usage: msg.usage };
  parsed.score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  return { ok: true, parsed, stopReason: msg.stop_reason, cost, usage: msg.usage };
}

// ---- mock mode (ANTHROPIC_MOCK=1) --------------------------------------------

const MOCK_DIR = path.join(ORCHESTRATOR_DIR, "test", "mock");
let mockCandidateCalls = 0;

async function mockCandidate(budget: Budget): Promise<CallResult<CandidateOutput>> {
  mockCandidateCalls++;
  const file = process.env.ANTHROPIC_MOCK_CANDIDATE ?? path.join(MOCK_DIR, "candidate.json");
  const raw = JSON.parse(await fsp.readFile(file, "utf8")) as { rounds?: CandidateOutput[] } & Partial<CandidateOutput>;
  const seq = raw.rounds ?? [raw as CandidateOutput];
  const pick = seq[Math.min(mockCandidateCalls - 1, seq.length - 1)]!;
  const usage: UsageLike = {
    input_tokens: 1200,
    output_tokens: 6000,
    cache_read_input_tokens: mockCandidateCalls > 1 ? 40_000 : 0,
    cache_creation_input_tokens: mockCandidateCalls > 1 ? 0 : 40_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: mockCandidateCalls > 1 ? 0 : 40_000 },
  };
  const cost = costOf(usage);
  budget.record(cost.usd);
  const parsed = CandidateOutput.parse(pick);
  return { ok: true, parsed, stopReason: "end_turn", cost, usage };
}

async function mockJudge(budget: Budget): Promise<CallResult<JudgeOutput>> {
  const file = process.env.ANTHROPIC_MOCK_JUDGE ?? path.join(MOCK_DIR, "judge.json");
  const parsed = JudgeOutput.parse(JSON.parse(await fsp.readFile(file, "utf8")));
  const usage: UsageLike = { input_tokens: 4500, output_tokens: 200 };
  const cost = costOf(usage);
  budget.record(cost.usd);
  return { ok: true, parsed, stopReason: "end_turn", cost, usage };
}
