import { decodeRecord, type EvaluationRecord } from "./record";

export interface ListedCheckRun {
  appSlug: string | null;
  checkSuiteId: number | null;
  status: string;
  completedAt: string | null;
  outputText: string | null;
}

export interface WorkflowRunOrigin {
  path: string;
  event: string;
}

export interface CheckRunReader {
  listCheckRuns(owner: string, repo: string, sha: string, name: string): Promise<ListedCheckRun[]>;
  workflowRunForCheckSuite(
    owner: string,
    repo: string,
    checkSuiteId: number,
  ): Promise<WorkflowRunOrigin | null>;
}

export interface TrustedWorkflow {
  appSlug: string;
  path: string;
  event: string;
}

export interface PreviousRecordQuery {
  owner: string;
  repo: string;
  sha: string;
  name: string;
  trustedWorkflow: TrustedWorkflow;
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
  const { owner, repo, sha, trustedWorkflow } = query;
  const runs = await reader.listCheckRuns(owner, repo, sha, query.name);
  const candidates = runs
    .filter((run) => run.appSlug === trustedWorkflow.appSlug)
    .flatMap((run) => {
      const millis = completedAtMillis(run);
      return millis === null || run.checkSuiteId === null
        ? []
        : [{ millis, checkSuiteId: run.checkSuiteId, outputText: run.outputText }];
    })
    .sort((a, b) => b.millis - a.millis);
  const origins = new Map<number, Promise<WorkflowRunOrigin | null>>();
  const originOf = (checkSuiteId: number) => {
    let origin = origins.get(checkSuiteId);
    if (origin === undefined) {
      origin = reader.workflowRunForCheckSuite(owner, repo, checkSuiteId);
      origins.set(checkSuiteId, origin);
    }
    return origin;
  };
  for (const candidate of candidates) {
    const record = decodeRecord(candidate.outputText);
    if (record === null || record.head !== sha) continue;
    const origin = await originOf(candidate.checkSuiteId);
    if (origin?.path === trustedWorkflow.path && origin.event === trustedWorkflow.event) {
      return record;
    }
  }
  return null;
}
