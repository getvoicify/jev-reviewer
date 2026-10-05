import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import type { Octokit } from "octokit";
import { ArtifactRecordStore, type ArtifactTransfer } from "../src/store/artifact-store";

interface ApiArtifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string | null;
  size_in_bytes: number;
  workflow_run?: { id?: number } | null;
}

function fakeOctokit(
  artifacts: ApiArtifact[] = [],
  getWorkflowRun: (params: unknown) => Promise<unknown> = async () => ({
    data: { id: 1, path: ".github/workflows/jev-gate.yml", event: "pull_request_target" },
  }),
) {
  const paginated: Array<{ endpoint: unknown; params: unknown }> = [];
  const runRequests: unknown[] = [];
  const listArtifactsForRepo = async () => ({ data: { artifacts } });
  const octokit = {
    rest: {
      actions: {
        listArtifactsForRepo,
        getWorkflowRun: async (params: unknown) => {
          runRequests.push(params);
          return getWorkflowRun(params);
        },
      },
    },
    paginate: async (endpoint: unknown, params: unknown) => {
      paginated.push({ endpoint, params });
      return artifacts;
    },
  } as unknown as Octokit;
  return { octokit, paginated, runRequests, listArtifactsForRepo };
}

interface Upload {
  name: string;
  files: string[];
  rootDirectory: string;
  retentionDays: number | undefined;
  contents: string[];
}

function fakeTransfer(onDownload: (path: string) => void = () => {}) {
  const uploads: Upload[] = [];
  const downloads: Array<{ id: number; options: unknown }> = [];
  const transfer: ArtifactTransfer = {
    async uploadArtifact(name, files, rootDirectory, options) {
      uploads.push({
        name,
        files,
        rootDirectory,
        retentionDays: options?.retentionDays,
        contents: files.map((file) => readFileSync(file, "utf8")),
      });
      return {};
    },
    async downloadArtifact(id, options) {
      downloads.push({ id, options });
      onDownload(options.path);
      return { downloadPath: options.path };
    },
  };
  return { transfer, uploads, downloads };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "artifact-store-"));
}

describe("ArtifactRecordStore.listArtifacts", () => {
  test("pages through every artifact of the given name in the repository", async () => {
    const { octokit, paginated, listArtifactsForRepo } = fakeOctokit();

    await new ArtifactRecordStore(
      octokit,
      fakeTransfer().transfer,
      "tok",
      tempRoot(),
    ).listArtifacts("o", "r", "jev-gate-record-abc");

    expect(paginated).toEqual([
      {
        endpoint: listArtifactsForRepo,
        params: { owner: "o", repo: "r", name: "jev-gate-record-abc", per_page: 100 },
      },
    ]);
  });

  test("maps each artifact to its id, name, uploading run, expiry, creation time and size", async () => {
    const { octokit } = fakeOctokit([
      {
        id: 7,
        name: "jev-gate-record-abc",
        expired: false,
        created_at: "2026-10-05T10:00:00Z",
        size_in_bytes: 13_017,
        workflow_run: { id: 42 },
      },
      {
        id: 8,
        name: "jev-gate-record-abc",
        expired: true,
        created_at: null,
        size_in_bytes: 1,
        workflow_run: null,
      },
      {
        id: 9,
        name: "jev-gate-record-abc",
        expired: false,
        created_at: null,
        size_in_bytes: 0,
        workflow_run: {},
      },
      {
        id: 10,
        name: "jev-gate-record-abc",
        expired: false,
        created_at: null,
        size_in_bytes: 70000,
      },
    ]);

    const listed = await new ArtifactRecordStore(
      octokit,
      fakeTransfer().transfer,
      "tok",
      tempRoot(),
    ).listArtifacts("o", "r", "jev-gate-record-abc");

    expect(listed).toEqual([
      {
        id: 7,
        name: "jev-gate-record-abc",
        workflowRunId: 42,
        expired: false,
        createdAt: "2026-10-05T10:00:00Z",
        sizeInBytes: 13_017,
      },
      {
        id: 8,
        name: "jev-gate-record-abc",
        workflowRunId: null,
        expired: true,
        createdAt: null,
        sizeInBytes: 1,
      },
      {
        id: 9,
        name: "jev-gate-record-abc",
        workflowRunId: null,
        expired: false,
        createdAt: null,
        sizeInBytes: 0,
      },
      {
        id: 10,
        name: "jev-gate-record-abc",
        workflowRunId: null,
        expired: false,
        createdAt: null,
        sizeInBytes: 70000,
      },
    ]);
  });
});

describe("ArtifactRecordStore.workflowRun", () => {
  test("returns the workflow file path and triggering event of the run", async () => {
    const { octokit, runRequests } = fakeOctokit([], async () => ({
      data: {
        id: 42,
        name: "Jev gate",
        path: ".github/workflows/jev-gate.yml",
        event: "pull_request",
      },
    }));

    const origin = await new ArtifactRecordStore(
      octokit,
      fakeTransfer().transfer,
      "tok",
      tempRoot(),
    ).workflowRun("o", "r", 42);

    expect(runRequests).toEqual([{ owner: "o", repo: "r", run_id: 42 }]);
    expect(origin).toEqual({ path: ".github/workflows/jev-gate.yml", event: "pull_request" });
  });

  test("returns null when the run no longer exists", async () => {
    const { octokit } = fakeOctokit([], async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    expect(
      await new ArtifactRecordStore(
        octokit,
        fakeTransfer().transfer,
        "tok",
        tempRoot(),
      ).workflowRun("o", "r", 42),
    ).toBeNull();
  });

  test("lets any other API failure propagate", async () => {
    const { octokit } = fakeOctokit([], async () => {
      throw Object.assign(new Error("Server Error"), { status: 500 });
    });

    await expect(
      new ArtifactRecordStore(octokit, fakeTransfer().transfer, "tok", tempRoot()).workflowRun(
        "o",
        "r",
        42,
      ),
    ).rejects.toThrow("Server Error");
  });
});

describe("ArtifactRecordStore.downloadRecordText", () => {
  test("downloads the artifact from its uploading run into a fresh directory under the temp root", async () => {
    const root = tempRoot();
    const { transfer, downloads } = fakeTransfer((path) =>
      writeFileSync(join(path, "jev-gate-record.txt"), "line"),
    );

    await new ArtifactRecordStore(fakeOctokit().octokit, transfer, "tok", root).downloadRecordText(
      "o",
      "r",
      { id: 7, workflowRunId: 42 },
    );

    expect(downloads).toHaveLength(1);
    const options = downloads[0]?.options as { path: string; findBy: unknown };
    expect(downloads[0]?.id).toBe(7);
    expect(options.findBy).toEqual({
      token: "tok",
      workflowRunId: 42,
      repositoryOwner: "o",
      repositoryName: "r",
    });
    expect(relative(root, options.path).startsWith("..")).toBe(false);
    expect(options.path).not.toBe(root);
  });

  test("returns the record file's text and removes the download directory", async () => {
    let downloadedTo = "";
    const { transfer } = fakeTransfer((path) => {
      downloadedTo = path;
      writeFileSync(join(path, "jev-gate-record.txt"), "the record line");
    });

    const text = await new ArtifactRecordStore(
      fakeOctokit().octokit,
      transfer,
      "tok",
      tempRoot(),
    ).downloadRecordText("o", "r", { id: 7, workflowRunId: 42 });

    expect(text).toBe("the record line");
    expect(existsSync(downloadedTo)).toBe(false);
  });

  test("returns null when the artifact holds no record file", async () => {
    const { transfer } = fakeTransfer((path) => {
      mkdirSync(join(path, "nested"));
      writeFileSync(join(path, "nested", "jev-gate-record.txt"), "misplaced");
      writeFileSync(join(path, "other.txt"), "not the record");
    });

    expect(
      await new ArtifactRecordStore(
        fakeOctokit().octokit,
        transfer,
        "tok",
        tempRoot(),
      ).downloadRecordText("o", "r", { id: 7, workflowRunId: 42 }),
    ).toBeNull();
  });
});

describe("ArtifactRecordStore.uploadRecord", () => {
  test("uploads a single record file holding the content, under the given name and retention", async () => {
    const root = tempRoot();
    const { transfer, uploads } = fakeTransfer();

    await new ArtifactRecordStore(fakeOctokit().octokit, transfer, "tok", root).uploadRecord(
      "jev-gate-record-abc",
      "the record line",
      12,
    );

    expect(uploads).toHaveLength(1);
    const upload = uploads[0] as Upload;
    expect(upload.name).toBe("jev-gate-record-abc");
    expect(upload.retentionDays).toBe(12);
    expect(upload.files.map((file) => basename(file))).toEqual(["jev-gate-record.txt"]);
    expect(upload.files.map((file) => relative(upload.rootDirectory, file))).toEqual([
      "jev-gate-record.txt",
    ]);
    expect(relative(root, upload.rootDirectory).startsWith("..")).toBe(false);
    expect(upload.contents).toEqual(["the record line"]);
  });

  test("removes the staging directory once the upload is done", async () => {
    const { transfer, uploads } = fakeTransfer();

    await new ArtifactRecordStore(fakeOctokit().octokit, transfer, "tok", tempRoot()).uploadRecord(
      "jev-gate-record-abc",
      "line",
      30,
    );

    expect(existsSync(uploads[0]?.rootDirectory ?? "")).toBe(false);
  });
});

describe("ArtifactTransfer", () => {
  test("is satisfied by the @actions/artifact client the action will hand the store", () => {
    const transfer: ArtifactTransfer = new DefaultArtifactClient();

    expect(typeof transfer.uploadArtifact).toBe("function");
    expect(typeof transfer.downloadArtifact).toBe("function");
  });
});
