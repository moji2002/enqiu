/**
 * Public entry point for the in-memory driver.
 *
 * The engine, its vocabulary, the shared error types and the heap live in
 * ./memory/*; this module keeps their combined surface at one import path.
 */

export * from "./memory/types.js";
export * from "./memory/errors.js";
export { MemoryQueue, memoryQueue } from "./memory/queue.js";
