import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DriveArgsError, parseDriveArgs } from "../scripts/drive-gate";

const HEAD = "a".repeat(40);
const BASE_ARGS = ["--repo", "tutela", "--base", "main", "--head", HEAD, "--action", "opened"];

function parse(extra: string[] = [], env: Record<string, string | undefined> = {}) {
  return parseDriveArgs([...BASE_ARGS, ...extra], env);
}

describe("parseDriveArgs", () => {
  test("reads a plain opened run with the stub Jev, no override and the base ref's config", () => {
    expect(parse()).toEqual({
      repo: resolve("tutela"),
      base: "main",
      head: HEAD,
      action: "opened",
      before: null,
      configFile: null,
      realJev: false,
      approveOverride: false,
      sender: null,
      label: null,
      model: "jev-latest",
    });
  });

  test("takes a local config file instead of the base ref's", () => {
    expect(parse(["--config", "gate.json"]).configFile).toBe("gate.json");
  });

  test.each(["repo", "base", "head", "action"])("requires --%s", (name) => {
    const argv = [...BASE_ARGS];
    argv.splice(argv.indexOf(`--${name}`), 2);
    expect(() => parseDriveArgs(argv, {})).toThrow(`--${name} is required`);
  });

  test("refuses a head that is not a full SHA", () => {
    const argv = [...BASE_ARGS];
    argv[argv.indexOf("--head") + 1] = "abc1234";
    expect(() => parseDriveArgs(argv, {})).toThrow("--head must be a full 40-character SHA");
  });

  test("refuses an unknown event action", () => {
    const argv = [...BASE_ARGS];
    argv[argv.indexOf("--action") + 1] = "closed";
    expect(() => parseDriveArgs(argv, {})).toThrow(/--action must be one of/);
  });

  test("refuses an unknown flag rather than ignoring it", () => {
    expect(() => parse(["--post"])).toThrow(DriveArgsError);
  });

  test("uses the real Jev only when asked and a key is set", () => {
    expect(parse(["--real-jev"], { TYPESAFE_API_KEY: "k" }).realJev).toBe(true);
    expect(() => parse(["--real-jev"], {})).toThrow("--real-jev needs TYPESAFE_API_KEY");
    expect(() => parse(["--real-jev"], { TYPESAFE_API_KEY: "  " })).toThrow(
      "--real-jev needs TYPESAFE_API_KEY",
    );
    expect(parse([], { TYPESAFE_API_KEY: "k" }).realJev).toBe(false);
  });

  test.each(["labeled", "unlabeled"])("requires the sender and the label on a %s run", (action) => {
    const argv = [...BASE_ARGS];
    argv[argv.indexOf("--action") + 1] = action;
    expect(() => parseDriveArgs([...argv, "--sender", "verygreenboi"], {})).toThrow(
      `a ${action} run needs --sender and --label`,
    );
    expect(() => parseDriveArgs([...argv, "--label", "jev-gate:override"], {})).toThrow(
      `a ${action} run needs --sender and --label`,
    );
    expect(
      parseDriveArgs([...argv, "--sender", "verygreenboi", "--label", "jev-gate:override"], {}),
    ).toMatchObject({ action, sender: "verygreenboi", label: "jev-gate:override" });
  });

  test("takes a before SHA only on a synchronize run", () => {
    expect(() => parse(["--before", HEAD])).toThrow("--before only applies to a synchronize run");
    const argv = [...BASE_ARGS];
    argv[argv.indexOf("--action") + 1] = "synchronize";
    expect(parseDriveArgs([...argv, "--before", HEAD], {}).before).toBe(HEAD);
  });

  test("passes the live override check only when asked", () => {
    expect(parse(["--approve-override"]).approveOverride).toBe(true);
  });
});
