import { z } from "zod";
import { metricKeys } from "../metrics";

const minimumScoreSchema = z.number().min(1).max(10);

const gateFileSchema = z
  .object({
    version: z.literal(1),
    gated: z.partialRecord(z.enum(metricKeys), minimumScoreSchema).optional(),
    advisoryFloor: minimumScoreSchema.optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    exclude: z.array(z.string()).optional(),
    limitTokens: z.number().int().positive().optional(),
    reservedTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

type GateFile = z.infer<typeof gateFileSchema>;

export type GateConfig = Required<Omit<GateFile, "exclude">> & Pick<GateFile, "exclude">;

export class GateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateConfigError";
  }
}

export const DEFAULT_GATE_CONFIG: Readonly<GateConfig> = Object.freeze({
  version: 1,
  gated: Object.freeze({ correctness: 7, security: 7, reliability: 7, testQuality: 7 }),
  advisoryFloor: 6,
  minConfidence: 0.5,
  limitTokens: 32000,
  reservedTokens: 4000,
});

export function parseGateConfig(raw: string | null): GateConfig {
  if (raw === null) return { ...DEFAULT_GATE_CONFIG, gated: { ...DEFAULT_GATE_CONFIG.gated } };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new GateConfigError(`Gate config is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = gateFileSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new GateConfigError(`Gate config is invalid: ${problems.join("; ")}`);
  }

  return {
    ...DEFAULT_GATE_CONFIG,
    gated: { ...DEFAULT_GATE_CONFIG.gated },
    ...parsed.data,
  };
}
