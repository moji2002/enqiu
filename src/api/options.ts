/** Normalises user-facing definitions and policies into driver options. */

import { compact } from "../internal/object.js";
import type {
  AddOptions,
  KeyedConcurrencyOptions,
  RetryOptions,
} from "../memory.js";
import {
  JobValidationError,
  definitionMarker,
  type JobDefinition,
  type JobHandler,
  type JobPolicyOptions,
  type NormalizedDefinition,
  type RetryPolicy,
  type StandardSchemaV1,
  type SubmitOptions,
} from "./types.js";

export function normalizeDefinition(definition: JobDefinition): NormalizedDefinition {
  if (typeof definition === "function") {
    return {
      schema: undefined,
      run: definition as JobHandler,
      policy: {},
    };
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
  const {
    input,
    run,
    retry,
    timeout,
    expiresIn,
    concurrency,
    throttle,
    debounce,
  } = definition;
  return {
    schema: input,
    run: run as JobHandler,
    policy: compact({
      retry,
      timeout,
      expiresIn,
      concurrency,
      throttle,
      debounce,
    }),
  };
}

export async function validateInput(
  name: string,
  schema: StandardSchemaV1 | undefined,
  input: unknown
): Promise<unknown> {
  if (!schema) {
    return input;
  }
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    throw new JobValidationError(name, result.issues);
  }
  return result.value;
}


export function normalizeRetryPolicy(
  value: number | RetryPolicy | undefined
): number | RetryOptions | undefined {
  if (typeof value === "number" || value === undefined) {
    return value;
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 1) {
    throw new RangeError("retry.attempts must be a positive integer");
  }
  return compact({
    retries: value.attempts - 1,
    backoff: value.backoff,
    when: value.when,
  });
}

export function toAddOptions(
  options: SubmitOptions,
  policy: JobPolicyOptions<unknown>,
  name: string,
  input: unknown
): AddOptions {
  const priority =
    typeof options.priority === "string"
      ? { low: -10, normal: 0, high: 10 }[options.priority]
      : options.priority;
  const concurrency = resolveConcurrency(policy.concurrency, name, input);
  const throttle = policy.throttle
    ? {
        limit: policy.throttle.limit,
        interval: policy.throttle.per,
        burst: policy.throttle.burst ?? policy.throttle.limit,
        key: `${name}:${resolvePolicyKey(
          "throttle.by",
          policy.throttle.by?.(input) ?? "*"
        )}`,
      }
    : undefined;
  const debounce = policy.debounce
    ? {
        wait: policy.debounce.wait,
        mode: policy.debounce.mode,
        key: resolvePolicyKey(
          "debounce.by",
          policy.debounce.by(input)
        ),
      }
    : undefined;
  return compact({
    id: options.id,
    key: options.idempotencyKey,
    keyRetention: options.idempotencyKey
      ? options.idempotencyTtl ?? 24 * 60 * 60 * 1000
      : undefined,
    delay: options.delay,
    priority,
    retry: normalizeRetryPolicy(options.retry ?? policy.retry),
    timeout: options.timeout ?? policy.timeout,
    expiresIn: options.expiresIn ?? policy.expiresIn,
    concurrency,
    throttle,
    debounce,
    signal: options.signal,
  });
}

export function resolveConcurrency(
  policy: JobPolicyOptions<unknown>["concurrency"],
  name: string,
  input: unknown
): KeyedConcurrencyOptions | undefined {
  if (policy === undefined) {
    return undefined;
  }
  // A bare number limits the job as a whole; `by` splits it per derived key.
  if (typeof policy === "number") {
    return { limit: policy, key: `${name}:*` };
  }
  return {
    limit: policy.limit,
    key: `${name}:${resolvePolicyKey(
      "concurrency.by",
      policy.by?.(input) ?? "*"
    )}`,
  };
}

export function resolvePolicyKey(name: string, value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must return a non-empty string`);
  }
  return value;
}

