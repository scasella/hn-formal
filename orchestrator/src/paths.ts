import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The orchestrator package directory (contains package.json). */
export const ORCHESTRATOR_DIR = path.resolve(here, "..");

/**
 * Repo root. Defaults to the parent of orchestrator/. Override with REPO_ROOT
 * (used by tests so release/rollback never touch the real tree).
 */
export function repoRoot(): string {
  return path.resolve(process.env.REPO_ROOT ?? path.resolve(ORCHESTRATOR_DIR, ".."));
}

export function fromRepo(...parts: string[]): string {
  return path.resolve(repoRoot(), ...parts);
}

export function cacheDir(): string {
  return path.resolve(process.env.ORCH_CACHE_DIR ?? path.join(ORCHESTRATOR_DIR, ".cache"));
}

export const EDITABLE_FILES = {
  renderLean: "HnFormal/Render.lean",
  styleCss: "site/style.css",
} as const;
