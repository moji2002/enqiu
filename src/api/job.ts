/**
 * `job()` — the schema-first way to declare a job, and the error a failed
 * input check produces.
 *
 * A handler alone is enough to define a job; this adds an input schema and
 * per-job policies. The returned object is frozen and marked, so the facade
 * can tell a real definition from an arbitrary object at runtime.
 */

import { definitionMarker } from "./types.js";
import type {
  SchemaJobDefinition,
  StandardSchemaIssue,
  StandardSchemaV1,
} from "./types.js";

export class JobValidationError extends TypeError {
  readonly issues: readonly StandardSchemaIssue[];

  constructor(name: string, issues: readonly StandardSchemaIssue[]) {
    super(
      `Invalid input for job "${name}": ${
        issues[0]?.message ?? "validation failed"
      }`
    );
    this.name = "JobValidationError";
    this.issues = issues;
  }
}

export function job<
  const Schema extends StandardSchemaV1,
  Output,
>(
  definition: Omit<SchemaJobDefinition<Schema, Output>, typeof definitionMarker>
): SchemaJobDefinition<Schema, Output> {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("job() requires a definition object");
  }
  if (!isStandardSchema(definition.input)) {
    throw new TypeError("job.input must implement Standard Schema");
  }
  if (typeof definition.run !== "function") {
    throw new TypeError("job.run must be a function");
  }
  return Object.freeze({
    ...definition,
    [definitionMarker]: true as const,
  });
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const standard = (value as Partial<StandardSchemaV1>)["~standard"];
  return (
    standard?.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}
