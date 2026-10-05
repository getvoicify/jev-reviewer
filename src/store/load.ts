import type { EvaluationRecord } from "./record";

export interface ListedArtifact {
  id: number;
  name: string;
  workflowRunId: number | null;
  expired: boolean;
  createdAt: string | null;
}

export interface WorkflowRunOrigin {
  path: string;
  event: string;
}

export interface ArtifactLocation {
  id: number;
  workflowRunId: number;
}

export interface RecordReader {
  listArtifacts(owner: string, repo: string, name: string): Promise<ListedArtifact[]>;
  workflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRunOrigin | null>;
  downloadRecordText(owner: string, repo: string, artifact: ArtifactLocation): Promise<string | null>;
}

export interface PreviousRecordQuery {
  owner: string;
  repo: string;
  sha: string;
  trustedWorkflow: WorkflowRunOrigin;
}

export async function loadPreviousRecord(
  _reader: RecordReader,
  _query: PreviousRecordQuery,
): Promise<EvaluationRecord | null> {
  return null;
}
