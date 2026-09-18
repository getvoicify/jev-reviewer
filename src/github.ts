import type { Octokit } from "octokit";

/**
 * Narrow seam over GitHub's REST API, injectable in tests so collection logic
 * never requires a live token or network access.
 */
export interface GitHubPort {
  /** Fetches the PR's unified diff via the `diff` media type. */
  getPullDiff(owner: string, repo: string, pullNumber: number): Promise<string>;
}

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
}
