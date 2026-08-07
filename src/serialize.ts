/**
 * The check that a job's value can survive the trip through the queue.
 *
 * BullMQ serialises on submit, so copying the value first would be redundant —
 * nothing the caller does afterwards can reach the stored job. What is worth
 * paying for is the error: `JSON.stringify` says "Converting circular structure
 * to JSON" once the value is already on its way to Redis, while this names the
 * exact path that cannot be stored.
 */

export class JobSerializationError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Job data at ${path} is not JSON-safe: ${reason}`);
    this.name = "JobSerializationError";
    this.path = path;
  }
}

/** Checks a value is storable and returns it unchanged. */
export function assertJobValue<T>(value: T): T {
  assertJsonSafe(value, [], new Set());
  return value;
}

type PathSegment = string | number;

/**
 * `["a", 0, "b"]` reads back as `$.a[0].b`.
 *
 * The path is carried as one array pushed and popped down the walk, and only
 * rendered when something is about to throw. Building the string at every node
 * cost more than the rest of the check put together.
 */
function fail(path: readonly PathSegment[], reason: string): never {
  let rendered = "$";
  for (const segment of path) {
    rendered += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  throw new JobSerializationError(rendered, reason);
}

function assertJsonSafe(
  value: unknown,
  path: PathSegment[],
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
    if (path.length > 0) {
      fail(path, "undefined is only valid as a root value");
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "numbers must be finite");
    return;
  }

  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    fail(path, `${typeof value} is unsupported`);
  }

  if (typeof value !== "object") fail(path, "unsupported value");

  if (ancestors.has(value)) fail(path, "circular reference");
  ancestors.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      path.push(index);
      if (!(index in value)) {
        fail(path, "sparse array entries are unsupported");
      }
      assertJsonSafe(value[index], path, ancestors);
      path.pop();
    }
    ancestors.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "only plain objects and arrays are supported");
  }

  const entries = value as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    path.push(key);
    if (entries[key] === undefined) {
      fail(path, "undefined object fields are unsupported");
    }
    assertJsonSafe(entries[key], path, ancestors);
    path.pop();
  }
  ancestors.delete(value);
}
