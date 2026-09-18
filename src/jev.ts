import type {
  Questions,
  RequestOptions,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";

export type JevErrorCode =
  | "missing_api_key"
  | "api_error"
  | "connection"
  | "timeout"
  | "aborted"
  | "unknown";

/**
 * Normalized error from the Jev client. Callers branch on `code`, never on SDK
 * internals, so the rest of the action stays decoupled from the SDK.
 */
export class JevError extends Error {
  readonly code: JevErrorCode;
  /** HTTP status when `code` is `api_error`; undefined otherwise. */
  readonly status?: number;

  constructor(code: JevErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JevError";
    this.code = code;
    this.status = options?.status;
  }
}

/**
 * Narrow seam over `TypeSafeClient.systemOne`, injectable in tests so the
 * action core never requires a live API key or network access.
 */
export interface JevPort {
  systemOne<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): Promise<SystemOneResult<Q>>;
}

export interface JevClientConfig {
  /** Explicit API key; falls back to `TYPESAFE_API_KEY`. Required unless `port` is injected. */
  apiKey?: string;
  /** Injectable transport for tests; bypasses SDK client construction. */
  port?: JevPort;
}

export class JevClient implements JevPort {
  readonly #port: JevPort;

  constructor(config: JevClientConfig = {}) {
    if (config.port) {
      this.#port = config.port;
      return;
    }
    const apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
      throw new JevError(
        "missing_api_key",
        "No TypeSafe API key: set the `typesafe-api-key` action input or the TYPESAFE_API_KEY environment variable",
      );
    }
    this.#port = new TypeSafeClient({ apiKey });
  }

  async systemOne<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): Promise<SystemOneResult<Q>> {
    try {
      return await this.#port.systemOne(request, options);
    } catch (err) {
      throw toJevError(err);
    }
  }
}

function toJevError(err: unknown): JevError {
  if (err instanceof JevError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof APIError) {
    return new JevError("api_error", message, { status: err.status, cause: err });
  }
  // APITimeoutError extends APIConnectionError; check the subclass first.
  if (err instanceof APITimeoutError) {
    return new JevError("timeout", message, { cause: err });
  }
  if (err instanceof APIConnectionError) {
    return new JevError("connection", message, { cause: err });
  }
  if (err instanceof APIUserAbortError) {
    return new JevError("aborted", message, { cause: err });
  }
  return new JevError("unknown", message, { cause: err });
}
