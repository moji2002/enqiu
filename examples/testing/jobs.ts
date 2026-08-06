import {
  enqiu,
  type MemoryEnqiuOptions,
  type DriverEnqiuOptions,
} from "enqiu";

function readName(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return value.name;
  }
  throw new TypeError("name must be a string");
}

/**
 * Build a fresh in-memory queue per test so no worker or queued state is shared
 * between cases.
 */
export function createJobs(options?: MemoryEnqiuOptions) {
  return enqiu(
    {
      sendWelcome: async (input: unknown) => ({
        subject: `Welcome, ${readName(input)}`,
      }),
    },
    options,
  );
}

/** Use the same public contract with an injected Redis driver. */
export function createRedisJobs(options: DriverEnqiuOptions) {
  return enqiu(
    {
      sendWelcome: async (input: unknown) => ({
        subject: `Welcome, ${readName(input)}`,
      }),
    },
    options,
  );
}
