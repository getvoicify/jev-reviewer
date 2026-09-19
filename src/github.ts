import type { Octokit } from "octokit";
import { type Annotation, batchAnnotations } from "./report";

export interface PrDetails {
  number: number;
  title: string;
  body: string;
  headSha: string;
}

export interface CheckRunParams {
  headSha: string;
  conclusion: "success" | "failure";
  summary: string;
  annotations: Annotation[];
}

/** Minimal surface needed by diff collection; keeps collect.ts decoupled from reporting. */
export interface DiffSource {
  getPullDiff(owner: string, repo: string, pullNumber: number): Promise<string>;
}

export interface GitHubPort extends DiffSource {
  getPr(owner: string, repo: string, pullNumber: number): Promise<PrDetails>;
  createComment(owner: string, repo: string, pullNumber: number, body: string): Promise<void>;
  createCheckRun(owner: string, repo: string, params: CheckRunParams): Promise<void>;
}

const CHECK_NAME = "jev-review";
const CHECK_TITLE = "Jev PR review";
const ANNOTATION_BATCH_SIZE = 50;

export class GitHubClient implements GitHubPort {
  readonly #octokit: Octokit;

  constructor(octokit: Octokit) {
    this.#octokit = octokit;
  }

  async getPullDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    const { data } = await this.#octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: "diff" },
    });
    // SAFETY: mediaType "diff" makes GitHub return the raw unified diff as a string body,
    // which octokit's endpoint schema (typed for the default JSON response) cannot express.
    return data as unknown as string;
  }

  async getPr(owner: string, repo: string, pullNumber: number): Promise<PrDetails> {
    const { data } = await this.#octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (!data.head) throw new Error("PR has no head commit");
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      headSha: data.head.sha,
    };
  }

  async createComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<void> {
    await this.#octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
  }

  async createCheckRun(owner: string, repo: string, params: CheckRunParams): Promise<void> {
    const batches = batchAnnotations(params.annotations, ANNOTATION_BATCH_SIZE);
    const firstBatch = batches[0] ?? [];
    const { data } = await this.#octokit.rest.checks.create({
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: params.headSha,
      status: "completed",
      conclusion: params.conclusion,
      completed_at: new Date().toISOString(),
      output: { title: CHECK_TITLE, summary: params.summary, annotations: firstBatch },
    });
    for (const batch of batches.slice(1)) {
      await this.#octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: data.id,
        output: { title: CHECK_TITLE, summary: params.summary, annotations: batch },
      });
    }
  }
}
