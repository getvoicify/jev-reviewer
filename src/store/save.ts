import { type EvaluationRecord, encodeRecord } from "./record";

export const RECORD_RETENTION_DAYS = 30;

export interface RecordWriter {
  uploadRecord(name: string, content: string, retentionDays: number): Promise<void>;
}

export function recordArtifactName(head: string): string {
  return `jev-gate-record-${head}`;
}

export async function saveRecord(
  writer: RecordWriter,
  record: EvaluationRecord,
  { retentionDays = RECORD_RETENTION_DAYS }: { retentionDays?: number } = {},
): Promise<void> {
  await writer.uploadRecord(recordArtifactName(record.head), encodeRecord(record), retentionDays);
}
