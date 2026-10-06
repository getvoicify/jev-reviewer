import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createGitPort } from "../src/diff/git";
import { partition } from "../src/diff/partition";
import { cumulativeDiff } from "../src/diff/source";
import { type GateConfig, GateConfigError, parseGateConfig } from "../src/gate/config";
import { gateFlags } from "../src/gate/flags";
import { changedLines, type GateGitHubPort, runGate } from "../src/gate/run";
import type { GateCheckRunParams } from "../src/github";
import { JevClient, type JevPort } from "../src/jev";
import { metricKeys } from "../src/metrics";
import type { RecordReader } from "../src/store/load";
import type { RecordWriter } from "../src/store/save";

const ACTIONS = ["opened", "synchronize", "reopened", "labeled", "unlabeled"] as const;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const GATE_CONFIG_PATH = ".github/jev-gate.json";

export type DriveArgs = {
  repo: string;
  base: string;
  head: string;
  action: (typeof ACTIONS)[number];
  before: string | null;
  configFile: string | null;
  realJev: boolean;
  approveOverride: boolean;
  sender: string | null;
  label: string | null;
  model: string;
  overrideActors: string[];
};

export class DriveArgsError extends Error {}

export function parseDriveArgs(argv: string[], env: Record<string, string | undefined>): DriveArgs {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        repo: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        action: { type: "string" },
        before: { type: "string" },
        config: { type: "string" },
        "real-jev": { type: "boolean", default: false },
        "approve-override": { type: "boolean", default: false },
        sender: { type: "string" },
        label: { type: "string" },
        model: { type: "string", default: "jev-latest" },
        "override-actor": { type: "string", multiple: true },
      },
    }));
  } catch (error) {
    throw new DriveArgsError((error as Error).message);
  }
  const text = (name: string): string | null => {
    const value = values[name];
    return typeof value === "string" && value !== "" ? value : null;
  };
  const required = (name: string): string => {
    const value = text(name);
    if (value === null) throw new DriveArgsError(`--${name} is required`);
    return value;
  };

  const head = required("head");
  if (!COMMIT_SHA.test(head)) throw new DriveArgsError("--head must be a full 40-character SHA");
  const action = required("action");
  if (!ACTIONS.includes(action as DriveArgs["action"])) {
    throw new DriveArgsError(`--action must be one of ${ACTIONS.join(", ")}`);
  }
  const before = text("before");
  if (before !== null && action !== "synchronize") {
    throw new DriveArgsError("--before only applies to a synchronize run");
  }
  const sender = text("sender");
  const label = text("label");
  if ((action === "labeled" || action === "unlabeled") && (sender === null || label === null)) {
    throw new DriveArgsError(`a ${action} run needs --sender and --label`);
  }
  const realJev = values["real-jev"] === true;
  if (realJev && (env.TYPESAFE_API_KEY ?? "").trim() === "") {
    throw new DriveArgsError("--real-jev needs TYPESAFE_API_KEY in the environment");
  }

  return {
    repo: resolve(required("repo")),
    base: required("base"),
    head,
    action: action as DriveArgs["action"],
    before,
    configFile: text("config"),
    realJev,
    approveOverride: values["approve-override"] === true,
    sender,
    label,
    model: text("model") ?? "jev-latest",
    overrideActors: (values["override-actor"] as string[] | undefined) ?? ["verygreenboi"],
  };
}

function readConfigText(args: DriveArgs): string | null {
  if (args.configFile !== null) return readFileSync(args.configFile, "utf8");
  const shown = spawnSync("git", ["show", `origin/${args.base}:${GATE_CONFIG_PATH}`], {
    cwd: args.repo,
    encoding: "utf8",
  });
  return shown.status === 0 ? shown.stdout : null;
}

function parsedOrNull(configText: string | null): GateConfig | null {
  try {
    return parseGateConfig(configText);
  } catch (error) {
    if (error instanceof GateConfigError) return null;
    throw error;
  }
}

function stubJev(): JevPort {
  const answers: Record<string, unknown> = {};
  for (const key of metricKeys) {
    answers[`${key}_applicable`] = { type: "noul", noul: 0.95 };
    answers[`${key}_score`] = {
      type: "score",
      score: 8.5,
      confidence: 0.9,
      legend: {},
      probabilities: {},
    };
    answers[`${key}_weakness`] = {
      type: "choice",
      choice: "no_material_issue",
      confidence: 0.8,
      probabilities: {},
    };
  }
  return {
    systemOne: async () =>
      ({ model: "stub", answers, usage: { input_tokens: 0, output_tokens: 0 } }) as never,
  };
}

function counted(port: JevPort): { port: JevPort; calls: () => number } {
  let calls = 0;
  return {
    port: {
      systemOne: (request, options) => {
        calls += 1;
        return port.systemOne(request, options);
      },
    },
    calls: () => calls,
  };
}

export async function drive(args: DriveArgs, print: (line: string) => void): Promise<void> {
  const git = createGitPort(args.repo);
  const checkedOut = git.resolve("HEAD");
  if (checkedOut !== args.head) {
    throw new Error(`the checkout is at ${checkedOut}, not --head ${args.head}`);
  }
  const configText = readConfigText(args);
  const config = parsedOrNull(configText);
  const diff = cumulativeDiff(git, { baseRef: args.base, exclude: config?.exclude });
  const flags = config === null ? null : gateFlags(diff, partition(diff.files, config));

  const checks: GateCheckRunParams[] = [];
  const comments: string[] = [];
  const posted: string[] = [];
  const github: GateGitHubPort = {
    overrideApproved: async (query) => {
      posted.push(`live override check for "${query.label}" -> ${args.approveOverride}`);
      return args.approveOverride;
    },
    removeLabel: async (_owner, _repo, _pr, label) => {
      posted.push(`would remove label "${label}"`);
    },
    getFileContent: async () => {
      if (configText === null) throw Object.assign(new Error("Not Found"), { status: 404 });
      return configText;
    },
    createGateCheckRun: async (_owner, _repo, params) => {
      checks.push(params);
    },
    upsertComment: async (_owner, _repo, _pr, body) => {
      comments.push(body);
    },
  };
  const records: RecordReader & RecordWriter = {
    listArtifacts: async () => [],
    workflowRun: async () => null,
    downloadRecordText: async () => null,
    uploadRecord: async (name, content) => {
      posted.push(`would save record ${name} (${content.length} chars)`);
    },
  };
  const jev = counted(args.realJev ? new JevClient() : stubJev());
  const logs: string[] = [];

  await runGate({
    context: {
      owner: "drive",
      repo: basename(args.repo),
      prNumber: 0,
      baseRef: args.base,
      headSha: args.head,
      beforeSha: args.before,
      eventAction: args.action,
      triggerLabel: args.label,
      sender: args.sender,
      eventAt: new Date().toISOString(),
    },
    settings: {
      model: args.model,
      trustedWorkflow: {
        path: ".github/workflows/jev-gate.yml",
        event: "pull_request_target",
        required: false,
      },
      overrideActors: args.overrideActors,
    },
    git,
    github,
    records,
    jev: jev.port,
    io: {
      info: (message) => logs.push(`info: ${message}`),
      warning: (message) => logs.push(`warning: ${message}`),
      fail: (message) => logs.push(`fail: ${message}`),
    },
  });

  const check = checks.at(-1);
  const plan = logs.find((line) => line.startsWith("info: plan: "))?.slice("info: plan: ".length);
  print(`config: ${args.configFile ?? `origin/${args.base}:${GATE_CONFIG_PATH}`}`);
  print(`plan: ${plan ?? "none (decided before planning)"}`);
  print(
    flags === null
      ? "flags: not computed (invalid gate config)"
      : `flags: oversized=${flags.oversized} codeChanged=${flags.codeChanged} unreviewedExcluded=${flags.unreviewedExcluded}`,
  );
  print(
    `changed lines in kept files: ${changedLines(diff.files)} (limit ${config?.maxChangedLines ?? "none"}) · kept files: ${diff.files.length} · excluded files: ${diff.excluded.length}`,
  );
  print(`jev calls: ${jev.calls()} (${args.realJev ? "real" : "stub"})`);
  print(`verdict: ${check?.conclusion ?? "no check posted"}`);
  print(`check title: ${check?.title ?? "-"}`);
  print("check summary:");
  print(check?.summary ?? "-");
  print("comment:");
  print(comments.at(-1) ?? "-");
  print("would post or write:");
  for (const line of posted.length === 0 ? ["nothing else"] : posted) print(`  ${line}`);
  print("gate log:");
  for (const line of logs) print(`  ${line}`);
}

if (import.meta.main) {
  try {
    await drive(parseDriveArgs(process.argv.slice(2), process.env), console.log);
  } catch (error) {
    console.error(`drive-gate: ${(error as Error).message}`);
    process.exit(1);
  }
}
