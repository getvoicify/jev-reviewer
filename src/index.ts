import { tmpdir } from "node:os";
import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "octokit";
import { runApp } from "./app";
import { createGitPort } from "./diff/git";
import { runGate } from "./gate/run";
import { GitHubClient } from "./github";
import { JevClient } from "./jev";
import { main } from "./main";
import { ArtifactRecordStore } from "./store/artifact-store";

const env = process.env;

await main({
  inputs: { get: core.getInput, getMultiline: core.getMultilineInput },
  env,
  event: () => ({
    name: github.context.eventName,
    payload: github.context.payload,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
  }),
  setFailed: core.setFailed,
  review: (config, context) =>
    runApp({
      config,
      githubPort: new GitHubClient(new Octokit({ auth: config.githubToken })),
      jev: new JevClient({ apiKey: config.apiKey }),
      context,
      io: { setOutput: core.setOutput, fail: core.setFailed, info: core.info },
    }),
  gate: (config, context) => {
    const octokit = new Octokit({ auth: config.githubToken });
    return runGate({
      context,
      settings: config,
      git: createGitPort(env.GITHUB_WORKSPACE || process.cwd()),
      github: new GitHubClient(octokit, core.warning),
      records: new ArtifactRecordStore(
        octokit,
        new DefaultArtifactClient(),
        config.githubToken,
        env.RUNNER_TEMP || tmpdir(),
      ),
      jev: new JevClient({ apiKey: config.apiKey }),
      io: { info: core.info, warning: core.warning, fail: core.setFailed },
    });
  },
});
