import type { GateContext } from "./run";

export interface GateEvent {
  name: string;
  payload: unknown;
  owner: string;
  repo: string;
}

interface PullRequestPayload {
  action?: unknown;
  before?: unknown;
  label?: { name?: unknown } | null;
  sender?: { login?: unknown } | null;
  pull_request?: {
    number?: unknown;
    base?: { ref?: unknown };
    head?: { sha?: unknown };
    updated_at?: unknown;
  };
}

export function gateContextFromEvent(event: GateEvent, trustedEvent: string): GateContext {
  if (event.name !== trustedEvent) {
    throw new Error(
      `gate mode runs only on the trusted "${trustedEvent}" event, got "${event.name}"`,
    );
  }
  const payload = (event.payload ?? {}) as PullRequestPayload;
  const pull = payload.pull_request;
  const prNumber = pull?.number;
  const baseRef = pull?.base?.ref;
  const headSha = pull?.head?.sha;
  if (typeof prNumber !== "number" || typeof baseRef !== "string" || typeof headSha !== "string") {
    throw new Error("the event payload has no pull request with a number, base ref and head SHA");
  }
  const eventAction = typeof payload.action === "string" ? payload.action : "";
  return {
    owner: event.owner,
    repo: event.repo,
    prNumber,
    baseRef,
    headSha,
    beforeSha:
      eventAction === "synchronize" && typeof payload.before === "string" ? payload.before : null,
    eventAction,
    triggerLabel: stringOrNull(payload.label?.name),
    sender: stringOrNull(payload.sender?.login),
    eventAt: stringOrNull(pull?.updated_at),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
