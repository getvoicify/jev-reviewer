import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  APIError,
  APITimeoutError,
  APIUserAbortError,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { JevClient, JevError, type JevPort } from "../src/jev";
import fixture from "./fixtures/systemone-basic.json";

type Request = SystemOneRequest<Questions>;
type Result = SystemOneResult<Questions>;

const REQUEST = fixture.request as unknown as Request;
const RESULT = fixture.response as unknown as Result;

function stubPort(result: Result): { port: JevPort; calls: Request[] } {
  const calls: Request[] = [];
  const systemOne = async (request: Request) => {
    calls.push(request);
    return result;
  };
  return { port: { systemOne: systemOne as JevPort["systemOne"] }, calls };
}

function failingPort(throwError: () => never): JevPort {
  return {
    async systemOne() {
      throwError();
    },
  };
}

describe("JevClient", () => {
  const originalKey = process.env.TYPESAFE_API_KEY;

  beforeAll(() => {
    delete process.env.TYPESAFE_API_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  });

  test("evaluate forwards the request and returns the result unchanged", async () => {
    const { port, calls } = stubPort(RESULT);
    const client = new JevClient({ port });

    const answer = await client.systemOne(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(REQUEST);
    expect(answer).toBe(RESULT);
  });

  test("missing API key throws JevError with code missing_api_key", () => {
    try {
      new JevClient({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JevError);
      expect((err as JevError).code).toBe("missing_api_key");
      expect((err as JevError).message).toContain("TYPESAFE_API_KEY");
    }
  });

  test("constructs without throwing when TYPESAFE_API_KEY is set", () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    try {
      expect(() => new JevClient({})).not.toThrow();
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  test("maps SDK APIError to JevError api_error preserving status", async () => {
    const client = new JevClient({
      port: failingPort(() => {
        throw APIError.fromResponse(429, { error: "too many requests" }, new Headers());
      }),
    });

    try {
      await client.systemOne(REQUEST);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JevError);
      const jevErr = err as JevError;
      expect(jevErr.code).toBe("api_error");
      expect(jevErr.status).toBe(429);
    }
  });

  test("maps APITimeoutError to JevError timeout", async () => {
    const client = new JevClient({
      port: failingPort(() => {
        throw new APITimeoutError(10_000);
      }),
    });

    try {
      await client.systemOne(REQUEST);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JevError);
      expect((err as JevError).code).toBe("timeout");
    }
  });

  test("maps APIUserAbortError to JevError aborted", async () => {
    const client = new JevClient({
      port: failingPort(() => {
        throw new APIUserAbortError("cancelled");
      }),
    });

    try {
      await client.systemOne(REQUEST);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JevError);
      expect((err as JevError).code).toBe("aborted");
    }
  });

  test("maps unknown errors to JevError unknown", async () => {
    const client = new JevClient({
      port: failingPort(() => {
        throw new Error("something exploded");
      }),
    });

    try {
      await client.systemOne(REQUEST);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JevError);
      expect((err as JevError).code).toBe("unknown");
    }
  });
});
