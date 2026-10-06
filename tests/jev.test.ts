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

  async function caught(throwing: () => never): Promise<JevError> {
    try {
      await new JevClient({ port: failingPort(throwing) }).systemOne(REQUEST);
    } catch (err) {
      if (err instanceof JevError) return err;
    }
    throw new Error("expected a JevError");
  }

  test("reads the structured error type from an API error body", async () => {
    const err = await caught(() => {
      throw APIError.fromResponse(
        400,
        { detail: { error_type: "max_tokens_exceeded" } },
        new Headers(),
      );
    });
    expect(err.status).toBe(400);
    expect(err.errorType).toBe("max_tokens_exceeded");
  });

  const untyped: [string, unknown][] = [
    ["a text body that mentions the type", '{"detail":{"error_type":"max_tokens_exceeded"}}'],
    ["a body with no detail", { error_type: "max_tokens_exceeded" }],
    ["a detail that is a string", { detail: "max_tokens_exceeded" }],
    ["an error type that is not a string", { detail: { error_type: ["max_tokens_exceeded"] } }],
    ["an error type with spaces or markup", { detail: { error_type: "max tokens <b>" } }],
    ["an overlong error type", { detail: { error_type: "a".repeat(65) } }],
    ["no body", undefined],
  ];

  for (const [kind, body] of untyped) {
    test(`leaves the error type unset for ${kind}`, async () => {
      const err = await caught(() => {
        throw APIError.fromResponse(400, body, new Headers());
      });
      expect(err.status).toBe(400);
      expect(err.errorType).toBeUndefined();
    });
  }

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
