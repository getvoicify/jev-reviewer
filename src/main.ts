import type { AppContext } from "./app";
import type { Config, GateModeConfig } from "./config";
import type { GateEvent } from "./gate/event";
import type { GateContext } from "./gate/run";

export interface ActionInputs {
  get(name: string): string;
  getMultiline(name: string): string[];
}

export interface MainDeps {
  inputs: ActionInputs;
  env: Record<string, string | undefined>;
  event: GateEvent;
  setFailed(message: string): void;
  review(config: Config, context: AppContext): Promise<void>;
  gate(config: GateModeConfig, context: GateContext): Promise<void>;
}

export async function main(_deps: MainDeps): Promise<void> {}
