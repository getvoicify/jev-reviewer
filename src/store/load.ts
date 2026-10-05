import { decodeRecord, type EvaluationRecord } from "./record";
import { recordArtifactName } from "./save";

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
  downloadRecordText(
    owner: string,
    repo: string,
    artifact: ArtifactLocation,
  ): Promise<string | null>;
}

export interface PreviousRecordQuery {
  owner: string;
  repo: string;
  sha: string;
  trustedWorkflow: WorkflowRunOrigin;
}

function createdAtMillis(artifact: ListedArtifact): number | null {
  if (artifact.createdAt === null) return null;
  const millis = Date.parse(artifact.createdAt);
  return Number.isNaN(millis) ? null : millis;
}

export async function loadPreviousRecord(
  reader: RecordReader,
  query: PreviousRecordQuery,
): Promise<EvaluationRecord | null> {
  const { owner, repo, sha, trustedWorkflow } = query;
  const name = recordArtifactName(sha);
  const artifacts = await reader.listArtifacts(owner, repo, name);
  const candidates = artifacts
    .filter((artifact) => artifact.name === name && !artifact.expired)
    .flatMap((artifact) => {
      const millis = createdAtMillis(artifact);
      return millis === null || artifact.workflowRunId === null
        ? []
        : [{ millis, id: artifact.id, workflowRunId: artifact.workflowRunId }];
    })
    .sort((a, b) => b.millis - a.millis);
  const origins = new Map<number, Promise<WorkflowRunOrigin | null>>();
  const originOf = (runId: number) => {
    let origin = origins.get(runId);
    if (origin === undefined) {
      origin = reader.workflowRun(owner, repo, runId);
      origins.set(runId, origin);
    }
    return origin;
  };
  for (const candidate of candidates) {
    const origin = await originOf(candidate.workflowRunId);
    if (origin?.path !== trustedWorkflow.path || origin.event !== trustedWorkflow.event) continue;
    const text = await reader.downloadRecordText(owner, repo, candidate);
    const record = decodeRecord(text);
    if (record !== null && record.head === sha) return record;
  }
  return null;
}
