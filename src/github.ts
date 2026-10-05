import type { Octokit } from "octokit";
import { type Annotation, batchAnnotations, COMMENT_MARKER } from "./report";

export interface PrDetails {
  number: number;
  title: string;
  body: string;
  headSha: string;
  /** The PR's base branch; question overrides are read from it. */
  baseRef: string;
}

export interface CheckRunParams {
  headSha: string;
  conclusion: "success" | "failure";
  summary: string;
  annotations: Annotation[];
}

export interface GateCheckRunParams {
  name: string;
  headSha: string;
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  text: string;
  annotations: Annotation[];
}

/** Minimal surface needed by diff collection; keeps collect.ts decoupled from reporting. */
export interface DiffSource {
  getPullDiff(owner: string, repo: string, pullNumber: number): Promise<string>;
}

export interface GitHubPort extends DiffSource {
  getPr(owner: string, repo: string, pullNumber: number): Promise<PrDetails>;
  /** Reads a file at a ref (the question-override config), raw content. */
  getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string>;
  /** Creates the review comment on first run, updates it on re-reviews. */
  upsertComment(owner: string, repo: string, pullNumber: number, body: string): Promise<void>;
  createCheckRun(owner: string, repo: string, params: CheckRunParams): Promise<void>;
}

const CHECK_NAME = "jev-review";
const CHECK_TITLE = "Jev PR review";
const ANNOTATION_BATCH_SIZE = 50;

/** Returns the id of the first comment carrying the marker, or null. */
export function selectUpsertTarget(
  comments: Array<{ id: number; body?: string | null; user?: { login: string } | null }>,
  marker: string,
  author?: string,
): number | null {
  for (const comment of comments) {
    if (author !== undefined && comment.user?.login !== author) continue;
    if (comment.body?.includes(marker)) return comment.id;
  }
  return null;
}

export interface OverrideQuery {
  owner: string;
  repo: string;
  prNumber: number;
  label: string;
  actors: string[];
}

export class GitHubClient implements GitHubPort {
  readonly #octokit: Octokit;
  readonly #warn: (message: string) => void;

  constructor(octokit: Octokit, warn: (message: string) => void = () => {}) {
    this.#octokit = octokit;
    this.#warn = warn;
  }

  async overrideApproved(query: OverrideQuery): Promise<boolean> {
    if (query.actors.length === 0) return false;
    try {
      return await this.#overrideApproved(query);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#warn(
        `Could not confirm the "${query.label}" override, so it is not honoured: ${reason}`,
      );
      return false;
    }
  }

  async #overrideApproved({ owner, repo, prNumber, label, actors }: OverrideQuery) {
    const params = { owner, repo, issue_number: prNumber, per_page: 100 };
    const labels = await this.#octokit.paginate(
      this.#octokit.rest.issues.listLabelsOnIssue,
      params,
    );
    if (!labels.some((present) => present.name === label)) return false;
    const events = await this.#octokit.paginate(this.#octokit.rest.issues.listEvents, params);
    const latest = events
      .filter(
        (event) => event.event === "labeled" && "label" in event && event.label.name === label,
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
      .at(-1);
    const login = latest?.actor?.login;
    return login !== undefined && actors.includes(login);
  }

  async removeLabel(owner: string, repo: string, prNumber: number, label: string): Promise<void> {
    try {
      await this.#octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: prNumber,
        name: label,
      });
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status !== 404) throw error;
    }
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
      baseRef: data.base.ref,
    };
  }

  async getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string> {
    const { data } = await this.#octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
      mediaType: { format: "raw" },
    });
    // SAFETY: mediaType "raw" makes GitHub return the file body as a string,
    // which octokit's schema (typed for the default JSON response) cannot express.
    return data as unknown as string;
  }

  async upsertComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    marker: string = COMMENT_MARKER,
    author?: string,
  ): Promise<void> {
    const comments = await this.#octokit.paginate(this.#octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
    });
    const existingId = selectUpsertTarget(comments, marker, author);
    if (existingId === null) {
      await this.#octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
      return;
    }
    const existing = comments.find((comment) => comment.id === existingId);
    if (existing?.body === body) return; // identical re-run; save an API call
    await this.#octokit.rest.issues.updateComment({ owner, repo, comment_id: existingId, body });
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

  async createGateCheckRun(owner: string, repo: string, params: GateCheckRunParams): Promise<void> {
    const [firstBatch = [], ...rest] = batchAnnotations(params.annotations, ANNOTATION_BATCH_SIZE);
    const { title, summary, text } = params;
    const { data } = await this.#octokit.rest.checks.create({
      owner,
      repo,
      name: params.name,
      head_sha: params.headSha,
      status: "completed",
      conclusion: params.conclusion,
      completed_at: new Date().toISOString(),
      output: { title, summary, text, annotations: firstBatch },
    });
    for (const batch of rest) {
      await this.#octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: data.id,
        output: { title, summary, annotations: batch },
      });
    }
  }
}
