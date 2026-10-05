import { decodeRecord, type EvaluationRecord } from "./record";

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

function completedAtMillis(run: ListedCheckRun): number | null {
  if (run.status !== "completed" || run.completedAt === null) return null;
  const millis = Date.parse(run.completedAt);
  return Number.isNaN(millis) ? null : millis;
}

export async function loadPreviousRecord(
  reader: CheckRunReader,
  query: PreviousRecordQuery,
): Promise<EvaluationRecord | null> {
  const runs = await reader.listCheckRuns(query.owner, query.repo, query.sha, query.name);
  const candidates = runs
    .filter((run) => run.appSlug === query.trustedAppSlug)
    .flatMap((run) => {
      const millis = completedAtMillis(run);
      return millis === null ? [] : [{ millis, outputText: run.outputText }];
    })
    .sort((a, b) => b.millis - a.millis);
  for (const candidate of candidates) {
    const record = decodeRecord(candidate.outputText);
    if (record !== null) return record;
  }
  return null;
}
