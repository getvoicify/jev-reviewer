import { choice, noul, score } from "@typesafe-ai/sdk";
import type { DiffChunk, PrMeta } from "./types";

/**
 * Atomic question set for one diff chunk. Each question is a single snap
 * judgment; composition and thresholds live in review.ts, never in prompts.
 */
export function buildChunkQuestions() {
  return {
    risk: score("How risky is the change in `state.diff` to the file `state.file`?", [
      "Trivial: cosmetic or no behavior change",
      "Low: minor behavior change with limited blast radius",
      "Moderate: meaningful behavior change",
      "High: substantial change or subtle failure modes",
      "Critical: data loss, security exposure, or outage risk",
    ]),
    has_bug: noul("Does `state.diff` introduce a bug or logic error?"),
    needs_tests: noul("Does `state.diff` change behavior that needs test coverage?"),
    security_sensitive: noul(
      "Does `state.diff` touch authentication, authorization, secrets, input validation, or unsafe parsing?",
      {
        true: "The diff involves security-sensitive code paths",
        false: "The diff is unrelated to security",
      },
    ),
    category: choice("What kind of change is `state.diff`?", {
      feature: "Adds new capability",
      bugfix: "Fixes a defect",
      refactor: "Restructures code without changing behavior",
      docs: "Documentation only",
      config: "Build, deploy, or configuration",
      other: null,
    }),
  } as const;
}

/** Atomic question set for PR-level metadata. */
export function buildPrQuestions() {
  return {
    breaking_change: noul("Does this PR introduce a breaking change for consumers?", {
      true: "Existing consumers must change how they use the API",
      false: "Backwards compatible",
    }),
    release_notes_worthy: noul("Should this PR be called out in release notes?"),
  } as const;
}

/** Structured state for chunk questions, with paths referenced from instructions. */
export function buildChunkState(chunk: DiffChunk) {
  return { file: chunk.file, diff: chunk.content };
}

/** Structured state for PR-level questions. */
export function buildPrState(meta: PrMeta) {
  return { title: meta.title, body: meta.body, filenames: meta.filenames };
}
