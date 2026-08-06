/** Error shapes shared by every driver. */

export interface SerializedError {
  name: string;
  message: string;
  stack?: string | undefined;
}

export function serializeError(error: Error): SerializedError {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function errorFromSerialized(
  value: SerializedError | undefined
): Error {
  const error = new Error(value?.message ?? "Job attempt failed");
  error.name = value?.name ?? "Error";
  if (value?.stack) {
    error.stack = value.stack;
  }
  return error;
}
