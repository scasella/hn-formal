// Manual helper: `npx tsx test/probe-auth.ts` prints whether credentials resolve.
import { authAvailable, costOf } from "../src/anthropic.js";
console.log("auth available:", await authAvailable());
console.log("cost: 1.2k in + 40k 1h-cache-write + 6k out =", costOf({ input_tokens: 1200, output_tokens: 6000, cache_creation_input_tokens: 40000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40000 } }));
console.log("cost: >100K prompt (5k in + 98k cache read + 1k out) =", costOf({ input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 98000 }));
