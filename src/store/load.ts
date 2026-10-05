import type { EvaluationRecord } from "./record";

export interface ListedCheckRun {
  appSlug: string | null;
  status: string;
  completedAt: string | null;
  outputText: string | null;
}

export interface CheckRunReader {
  listCheckRuns(owner: string, repo: string, sha: string, name: string): Promise<ListedCheckRun[]>;
}

export interface PreviousRecordQuery {
  owner: string;
  repo: string;
  sha: string;
  name: string;
  trustedAppSlug: string;
}

export async function loadPreviousRecord(
  _reader: CheckRunReader,
  _query: PreviousRecordQuery,
): Promise<EvaluationRecord | null> {
  return null;
}
