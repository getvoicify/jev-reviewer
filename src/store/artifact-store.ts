import type { Octokit } from "octokit";
import type {
  ArtifactLocation,
  ListedArtifact,
  RecordReader,
  WorkflowRunOrigin,
} from "./load";
import type { RecordWriter } from "./save";

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

export class ArtifactRecordStore implements RecordReader, RecordWriter {
  constructor(
    readonly octokit: Octokit,
    readonly transfer: ArtifactTransfer,
    readonly token: string,
    readonly tempRoot: string,
  ) {}

  async listArtifacts(_owner: string, _repo: string, _name: string): Promise<ListedArtifact[]> {
    return [];
  }

  async workflowRun(_owner: string, _repo: string, _runId: number): Promise<WorkflowRunOrigin | null> {
    return null;
  }

  async downloadRecordText(
    _owner: string,
    _repo: string,
    _artifact: ArtifactLocation,
  ): Promise<string | null> {
    return null;
  }

  async uploadRecord(_name: string, _content: string, _retentionDays: number): Promise<void> {}
}
