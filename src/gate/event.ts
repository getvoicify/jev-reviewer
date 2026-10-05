import type { GateContext } from "./run";

export interface GateEvent {
  name: string;
  payload: unknown;
  owner: string;
  repo: string;
}

export function gateContextFromEvent(_event: GateEvent, _trustedEvent: string): GateContext {
  throw new Error("not implemented");
}
