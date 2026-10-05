import type { EvaluationRecord } from "./record";

export interface RecordWriter {
  uploadRecord(name: string, content: string, retentionDays: number): Promise<void>;
}

export async function saveRecord(
  _writer: RecordWriter,
  _record: EvaluationRecord,
  _options: { retentionDays?: number } = {},
): Promise<void> {}
