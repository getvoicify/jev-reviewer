import type { MetricKey } from "../metrics";

export type GateConfig = {
  version: 1;
  gated: Partial<Record<MetricKey, number>>;
  advisoryFloor: number;
  minConfidence: number;
  exclude?: string[];
  limitTokens: number;
  reservedTokens: number;
};

export class GateConfigError extends Error {}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  version: 1,
  gated: {},
  advisoryFloor: 0,
  minConfidence: 0,
  limitTokens: 0,
  reservedTokens: 0,
};

export function parseGateConfig(_raw: string | null): GateConfig {
  throw new Error("not implemented");
}
