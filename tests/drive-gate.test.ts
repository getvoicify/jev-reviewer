import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DriveArgs, DriveArgsError, drive, parseDriveArgs } from "../scripts/drive-gate";

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
      overrideActors: ["verygreenboi"],
    });
  });

  test("takes the override actors from repeated flags", () => {
    expect(parse(["--override-actor", "alice", "--override-actor", "bob"]).overrideActors).toEqual([
      "alice",
      "bob",
    ]);
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

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout(lines: number, lockLines = 0) {
  const repo = mkdtempSync(join(tmpdir(), "jev-drive-"));
  scratch.push(repo);
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo, "app.ts"), Array.from({ length: lines }, (_, i) => `x${i}`).join("\n"));
  if (lockLines > 0) {
    writeFileSync(
      join(repo, "bun.lock"),
      Array.from({ length: lockLines }, (_, i) => `l${i}`).join("\n"),
    );
  }
  git("add", ".");
  git("commit", "-q", "-m", "head");
  const config = join(repo, "..", `${repo.split("/").at(-1)}-gate.json`);
  scratch.push(config);
  writeFileSync(config, '{"version":1,"maxChangedLines":400}');
  return { repo, head: git("rev-parse", "HEAD"), config };
}

function driveArgs(at: ReturnType<typeof checkout>, overrides: Partial<DriveArgs> = {}): DriveArgs {
  return {
    ...parseDriveArgs(
      ["--repo", at.repo, "--base", "main", "--head", at.head, "--action", "opened"],
      {},
    ),
    configFile: at.config,
    ...overrides,
  };
}

async function printed(args: DriveArgs): Promise<string[]> {
  const lines: string[] = [];
  await drive(args, (line) => lines.push(line));
  return lines;
}

describe("drive", () => {
  test("drives an over-cap checkout to neutral with no Jev call and nothing written", async () => {
    const lines = await printed(driveArgs(checkout(401)));
    expect(lines).toContain("plan: none (decided before planning)");
    expect(lines).toContain(
      "added lines in kept files: 401 (limit 400) · kept files: 1 · excluded files: 0",
    );
    expect(lines).toContain("jev calls: 0 (stub)");
    expect(lines).toContain("verdict: neutral");
    expect(lines).toContain("  nothing else");
  });

  test("scores a checkout whose bulk is excluded with the stub Jev and only records what it would save", async () => {
    const at = checkout(10, 2000);
    const lines = await printed(driveArgs(at));
    expect(lines).toContain(
      "added lines in kept files: 10 (limit 400) · kept files: 1 · excluded files: 1",
    );
    expect(lines).toContain("jev calls: 1 (stub)");
    expect(
      lines.some((line) => line.startsWith(`  would save record jev-gate-record-${at.head}`)),
    ).toBe(true);
  });

  test("refuses to drive when the checkout is not at --head", async () => {
    const at = checkout(1);
    await expect(drive(driveArgs(at, { head: "b".repeat(40) }), () => {})).rejects.toThrow(
      `the checkout is at ${at.head}, not --head ${"b".repeat(40)}`,
    );
  });

  test("lets the gate report an invalid config instead of throwing", async () => {
    const at = checkout(1);
    writeFileSync(at.config, '{"version":1,"maxChangedLines":0}');
    const lines = await printed(driveArgs(at));
    expect(lines).toContain("verdict: failure");
    expect(lines).toContain("flags: not computed (invalid gate config)");
  });

  test("accepts an over-cap change for a configured override actor on a labeled run", async () => {
    const lines = await printed(
      driveArgs(checkout(401), {
        action: "labeled",
        sender: "alice",
        label: "jev-gate:override",
        approveOverride: true,
        overrideActors: ["alice"],
      }),
    );
    expect(lines).toContain("verdict: neutral");
    expect(lines.some((line) => line.startsWith("  warning: Neutral gate result accepted"))).toBe(
      true,
    );
    expect(lines.some((line) => line.startsWith("  fail:"))).toBe(false);
  });
});
