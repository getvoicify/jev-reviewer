import { describe, expect, test } from "bun:test";
import { gateContextFromEvent } from "../src/gate/event";

const HEAD = "a".repeat(40);
const BEFORE = "b".repeat(40);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "synchronize",
    before: BEFORE,
    pull_request: { number: 12, base: { ref: "main" }, head: { sha: HEAD } },
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}, name = "pull_request_target") {
  return { name, payload: payload(overrides), owner: "voicify", repo: "tutela" };
}

describe("gateContextFromEvent", () => {
  test("reads the PR, its base, its head and the push's before SHA", () => {
    expect(gateContextFromEvent(event(), "pull_request_target")).toEqual({
      owner: "voicify",
      repo: "tutela",
      prNumber: 12,
      baseRef: "main",
      headSha: HEAD,
      beforeSha: BEFORE,
      eventAction: "synchronize",
    });
  });

  for (const action of ["opened", "reopened", "labeled"]) {
    test(`ignores a before SHA on ${action}`, () => {
      const context = gateContextFromEvent(event({ action }), "pull_request_target");
      expect(context.beforeSha).toBeNull();
      expect(context.eventAction).toBe(action);
    });
  }

  test("has no before SHA when a synchronize payload carries none", () => {
    expect(
      gateContextFromEvent(event({ before: undefined }), "pull_request_target").beforeSha,
    ).toBeNull();
  });

  test("runs on pull_request when that is the trusted event", () => {
    expect(gateContextFromEvent(event({}, "pull_request"), "pull_request").prNumber).toBe(12);
  });

  test("refuses an event other than the trusted one", () => {
    expect(() => gateContextFromEvent(event({}, "pull_request"), "pull_request_target")).toThrow(
      'gate mode runs only on the trusted "pull_request_target" event, got "pull_request"',
    );
    expect(() => gateContextFromEvent(event({}, "push"), "pull_request_target")).toThrow(
      'got "push"',
    );
  });

  test("refuses a payload without a pull request", () => {
    expect(() =>
      gateContextFromEvent(event({ pull_request: undefined }), "pull_request_target"),
    ).toThrow("the event payload has no pull request");
  });

  for (const [label, pull_request] of [
    ["number", { base: { ref: "main" }, head: { sha: HEAD } }],
    ["base ref", { number: 12, head: { sha: HEAD } }],
    ["head SHA", { number: 12, base: { ref: "main" } }],
  ] as const) {
    test(`refuses a pull request payload without a ${label}`, () => {
      expect(() => gateContextFromEvent(event({ pull_request }), "pull_request_target")).toThrow(
        "the event payload has no pull request",
      );
    });
  }
});
