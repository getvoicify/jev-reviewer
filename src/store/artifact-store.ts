import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Octokit } from "octokit";
import type { ArtifactLocation, ListedArtifact, RecordReader, WorkflowRunOrigin } from "./load";
import type { RecordWriter } from "./save";

export const RECORD_FILE_NAME = "jev-gate-record.txt";

export interface ArtifactTransfer {
  uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
    options?: { retentionDays?: number },
  ): Promise<unknown>;
  downloadArtifact(
    artifactId: number,
    options: {
      path: string;
      findBy: {
        token: string;
        workflowRunId: number;
        repositoryOwner: string;
        repositoryName: string;
      };
    },
  ): Promise<{ downloadPath?: string }>;
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

export class ArtifactRecordStore implements RecordReader, RecordWriter {
  readonly #octokit: Octokit;
  readonly #transfer: ArtifactTransfer;
  readonly #token: string;
  readonly #tempRoot: string;

  constructor(octokit: Octokit, transfer: ArtifactTransfer, token: string, tempRoot: string) {
    this.#octokit = octokit;
    this.#transfer = transfer;
    this.#token = token;
    this.#tempRoot = tempRoot;
  }

  async listArtifacts(owner: string, repo: string, name: string): Promise<ListedArtifact[]> {
    const artifacts = await this.#octokit.paginate(
      this.#octokit.rest.actions.listArtifactsForRepo,
      {
        owner,
        repo,
        name,
        per_page: 100,
      },
    );
    return artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      workflowRunId: artifact.workflow_run?.id ?? null,
      expired: artifact.expired,
      createdAt: artifact.created_at,
      sizeInBytes: artifact.size_in_bytes,
    }));
  }

  async workflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRunOrigin | null> {
    try {
      const { data } = await this.#octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      return { path: data.path, event: data.event };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async downloadRecordText(
    owner: string,
    repo: string,
    artifact: ArtifactLocation,
  ): Promise<string | null> {
    const directory = mkdtempSync(join(this.#tempRoot, "jev-gate-record-"));
    try {
      const { downloadPath = directory } = await this.#transfer.downloadArtifact(artifact.id, {
        path: directory,
        findBy: {
          token: this.#token,
          workflowRunId: artifact.workflowRunId,
          repositoryOwner: owner,
          repositoryName: repo,
        },
      });
      try {
        return readFileSync(join(downloadPath, RECORD_FILE_NAME), "utf8");
      } catch {
        return null;
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async uploadRecord(name: string, content: string, retentionDays: number): Promise<void> {
    const directory = mkdtempSync(join(this.#tempRoot, "jev-gate-record-"));
    try {
      const file = join(directory, RECORD_FILE_NAME);
      writeFileSync(file, content, "utf8");
      await this.#transfer.uploadArtifact(name, [file], directory, { retentionDays });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
