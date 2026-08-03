import type { JobHandle, JobSnapshot, QueueStats } from "enqiu";

export type RecipeId = "sendEmail" | "resizeImage" | "syncAccount";
export type Priority = "low" | "normal" | "high";
export type DelayMs = 0 | 2_000 | 5_000;
export type RetryAttempts = 1 | 2 | 3;
export type Concurrency = 1 | 2 | 4;
export type QueueFilter =
  | "all"
  | "active"
  | "scheduled"
  | "succeeded"
  | "failed"
  | "stopped";
export type InspectorTab = "overview" | "input" | "logs" | "result";
export type MobileView = "compose" | "jobs" | "inspect";

export interface ComposerDraft {
  recipe: RecipeId;
  payload: string;
  priority: Priority;
  delayMs: DelayMs;
  retryAttempts: RetryAttempts;
  timeoutMs?: number;
  expiresInMs?: number;
  customId?: string;
  idempotencyKey?: string;
  failOnce: boolean;
}

export interface Recipe {
  id: RecipeId;
  label: string;
  description: string;
  capability: string;
  defaultPayload: Readonly<Record<string, unknown>>;
  supportsFailure: boolean;
}

export interface PlaygroundState {
  jobs: JobSnapshot[];
  stats: QueueStats;
  selectedId?: string;
  paused: boolean;
  concurrency: Concurrency;
  busyAction?: string;
  alert?: string;
}

export interface PlaygroundActions {
  enqueue(draft: ComposerDraft): Promise<void>;
  enqueueScenario(
    kind: "queue-three" | "fail-once" | "schedule-five",
    draft: ComposerDraft,
  ): Promise<void>;
  select(id: string): void;
  setPaused(paused: boolean): Promise<void>;
  setConcurrency(value: Concurrency): Promise<void>;
  cancelSelected(): Promise<void>;
  redriveSelected(): Promise<void>;
  draftFromSelected(): ComposerDraft | undefined;
  cleanup(scope: "succeeded" | "terminal"): Promise<void>;
  reset(): Promise<void>;
  clearAlert(): void;
}

export interface SubmittedJob {
  handle: JobHandle;
  input: Readonly<Record<string, unknown>>;
}
