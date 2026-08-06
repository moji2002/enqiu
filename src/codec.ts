export class JobSerializationError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Job data at ${path} is not JSON-safe: ${reason}`);
    this.name = "JobSerializationError";
    this.path = path;
  }
}

interface Envelope {
  value?: unknown;
}

/** Serialize the exact data contract shared by the memory and Redis drivers. */
export function encodeJobValue(value: unknown): string {
  assertJsonSafe(value, "$", new Set());
  return JSON.stringify({ value } satisfies Envelope);
}

export function decodeJobValue(value: string): unknown {
  const envelope = JSON.parse(value) as Envelope;
  return Object.prototype.hasOwnProperty.call(envelope, "value")
    ? envelope.value
    : undefined;
}

export function cloneJobValue<T>(value: T): T {
  return decodeJobValue(encodeJobValue(value)) as T;
}

/**
 * Checks a value is storable and returns it unchanged.
 *
 * The queue serialises on submit, so copying first is redundant: nothing the
 * caller does afterwards can reach the stored job. This keeps the precise
 * error path that makes an unserialisable value easy to find, without paying
 * for a JSON round trip per job.
 */
export function assertJobValue<T>(value: T): T {
  assertJsonSafe(value, "$", new Set());
  return value;
}

function assertJsonSafe(
  value: unknown,
  path: string,
  ancestors: Set<object>
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (value === undefined) {
    if (path !== "$") {
      throw new JobSerializationError(path, "undefined is only valid as a root value");
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JobSerializationError(path, "numbers must be finite");
    }
    return;
  }

  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new JobSerializationError(path, `${typeof value} is unsupported`);
  }

  if (typeof value !== "object") {
    throw new JobSerializationError(path, "unsupported value");
  }

  if (ancestors.has(value)) {
    throw new JobSerializationError(path, "circular reference");
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new JobSerializationError(
          `${path}[${index}]`,
          "sparse array entries are unsupported"
        );
      }
      assertJsonSafe(value[index], `${path}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JobSerializationError(
      path,
      "only plain objects and arrays are supported"
    );
  }

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      throw new JobSerializationError(
        `${path}.${key}`,
        "undefined object fields are unsupported"
      );
    }
    assertJsonSafe(entry, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}
