/** Turning what a caller wrote into something the worker can run. */

import { JobValidationError } from "./errors.js";
import { definitionMarker } from "./types.js";
import type {
  JobDefinition,
  JobHandler,
  JobPolicyOptions,
  SchemaJobDefinition,
  StandardSchemaV1,
} from "./types.js";

/** Declare a job with a Standard Schema input and per-job policies. */
export function job<const Schema extends StandardSchemaV1, Output>(
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
  return Object.freeze({ ...definition, [definitionMarker]: true as const });
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (!value || typeof value !== "object") return false;
  const standard = (value as Partial<StandardSchemaV1>)["~standard"];
  return (
    standard?.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

/** A definition reduced to the three things the runtime actually reads. */
export interface RuntimeDefinition {
  readonly schema: StandardSchemaV1 | undefined;
  readonly run: JobHandler;
  readonly policy: JobPolicyOptions;
}

export function normalizeDefinition(
  definition: JobDefinition
): RuntimeDefinition {
  if (typeof definition === "function") {
    return { schema: undefined, run: definition as JobHandler, policy: {} };
  }
  if (
    !definition ||
    typeof definition !== "object" ||
    definition[definitionMarker] !== true
  ) {
    throw new TypeError(
      "Every job must be a handler or a definition created with job()"
    );
  }
  const policy: JobPolicyOptions = {};
  if (definition.retry !== undefined) policy.retry = definition.retry;
  if (definition.timeout !== undefined) policy.timeout = definition.timeout;
  if (definition.expiresIn !== undefined) {
    policy.expiresIn = definition.expiresIn;
  }
  return { schema: definition.input, run: definition.run as JobHandler, policy };
}

export async function validateInput(
  name: string,
  schema: StandardSchemaV1 | undefined,
  input: unknown
): Promise<unknown> {
  if (!schema) return input;
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new JobValidationError(name, result.issues);
  return result.value;
}
