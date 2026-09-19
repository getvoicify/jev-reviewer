import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "octokit";
import { runApp } from "./app";
import { parseConfig } from "./config";
import { GitHubClient } from "./github";
import { JevClient } from "./jev";

async function run(): Promise<void> {
  const config = parseConfig(
    {
      apiKey: core.getInput("typesafe-api-key"),
      githubToken: core.getInput("github-token"),
      model: core.getInput("model"),
      comment: core.getInput("comment"),
      failOn: core.getInput("fail-on"),
      minConfidence: core.getInput("min-confidence"),
      maxFiles: core.getInput("max-files"),
      maxChunkChars: core.getInput("max-chunk-chars"),
      ignorePaths: core.getMultilineInput("ignore-paths"),
    },
    process.env,
  );

  // SAFETY: webhook payloads vary by event; we only read the PR number and
  // fail with a clear message when the event is not pull_request.
  const payload = github.context.payload as { pull_request?: { number: number } };
  const prNumber = payload.pull_request?.number ?? github.context.issue.number;
  if (!prNumber) throw new Error("Not a pull request event: no PR number in context");

  const octokit = new Octokit({ auth: config.githubToken });

  await runApp({
    config,
    githubPort: new GitHubClient(octokit),
    jev: new JevClient({ apiKey: config.apiKey }),
    context: { owner: github.context.repo.owner, repo: github.context.repo.repo, prNumber },
    io: { setOutput: core.setOutput, fail: core.setFailed, info: core.info },
  });
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
