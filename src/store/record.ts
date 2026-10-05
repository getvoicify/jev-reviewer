import { z } from "zod";
import { evaluationSchema } from "../metrics/schema";

export const RECORD_LINE_BUDGET = 30_000;

const MARKER_OPENING = "<!-- jev-gate-record:";
const LINE_PATTERN = /^<!-- jev-gate-record:v([12]) ([A-Za-z0-9_-]+) -->$/;

const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/);

const recordFields = {
  head: gitObjectId,
  mergeBase: gitObjectId,
  patchId: gitObjectId.nullable(),
  evaluator: z.string().regex(/^[0-9a-f]{64}$/),
  evaluation: evaluationSchema,
};

const v1RecordSchema = z.object({ version: z.literal(1), ...recordFields }).strict();

const overrideSchema = z
  .object({ actor: z.string().min(1), labeledAt: z.iso.datetime({ offset: true }) })
  .strict();

const recordSchema = z
  .object({ version: z.literal(2), ...recordFields, override: overrideSchema.optional() })
  .strict();

export type EvaluationRecord = z.infer<typeof recordSchema>;

export type RecordOverride = z.infer<typeof overrideSchema>;

export function encodeRecord(record: EvaluationRecord): string {
  const valid = recordSchema.parse(record);
  const line = `${MARKER_OPENING}v2 ${Buffer.from(JSON.stringify(valid), "utf8").toString("base64url")} -->`;
  if (line.length > RECORD_LINE_BUDGET) {
    throw new Error(
      `Evaluation record line is ${line.length} chars, over the ${RECORD_LINE_BUDGET}-char budget.`,
    );
  }
  return line;
}

export function decodeRecord(text: string | null): EvaluationRecord | null {
  if (text === null || text.split(MARKER_OPENING).length !== 2) return null;
  const firstLine = text.split("\n", 1)[0] ?? "";
  const [, version, payload] = LINE_PATTERN.exec(firstLine.replace(/\r$/, "")) ?? [];
  if (payload === undefined) return null;
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.toString("base64url") !== payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (version === "1") {
    const legacy = v1RecordSchema.safeParse(parsed);
    return legacy.success ? { ...legacy.data, version: 2 } : null;
  }
  const result = recordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
