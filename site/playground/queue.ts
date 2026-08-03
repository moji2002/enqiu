import {
  enqiu,
  type JobContext,
  type JobHandle,
  type SubmitOptions,
} from "enqiu";
import type {
  ComposerDraft,
  Recipe,
  RecipeId,
  SubmittedJob,
} from "./types";

interface SendEmailInput {
  to: string;
  subject: string;
}

interface ResizeImageInput {
  file: string;
  width: number;
  format: "webp" | "avif" | "png";
}

interface SyncAccountInput {
  account: string;
  failOnce?: boolean;
}

export class PlaygroundInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundInputError";
  }
}

export const RECIPES: readonly Recipe[] = Object.freeze([
  {
    id: "sendEmail",
    label: "Send email",
    description: "Watch a short job report progress and structured logs.",
    capability: "progress + logs",
    defaultPayload: {
      to: "hello@example.com",
      subject: "Your queue is ready",
    },
    supportsFailure: false,
  },
  {
    id: "resizeImage",
    label: "Resize image",
    description: "A longer job that makes cancellation and concurrency visible.",
    capability: "cancel + concurrency",
    defaultPayload: {
      file: "hero.png",
      width: 1440,
      format: "webp",
    },
    supportsFailure: false,
  },
  {
    id: "syncAccount",
    label: "Sync account",
    description: "Trigger a deterministic first-attempt failure and retry.",
    capability: "retry + redrive",
    defaultPayload: {
      account: "acct_115",
    },
    supportsFailure: true,
  },
]);

const recipeMap = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));

function wait(duration: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendEmail(
  input: SendEmailInput,
  { reportProgress, log, signal }: JobContext,
) {
  log.info("Preparing message", { to: input.to, subject: input.subject });
  await wait(260, signal);
  await reportProgress({ completed: 1, total: 3, message: "Prepared" });
  log.debug("Connecting to provider");
  await wait(320, signal);
  await reportProgress({ completed: 2, total: 3, message: "Connected" });
  await wait(380, signal);
  await reportProgress({ completed: 3, total: 3, message: "Accepted" });
  log.info("Provider accepted message", { to: input.to });
  return { delivered: true, to: input.to, subject: input.subject };
}

async function resizeImage(
  input: ResizeImageInput,
  { reportProgress, log, signal }: JobContext,
) {
  log.info("Reading source image", { file: input.file });
  const messages = ["Decoded", "Resized", "Optimized", "Encoded"];
  for (const [index, message] of messages.entries()) {
    await wait(360, signal);
    await reportProgress({
      completed: index + 1,
      total: messages.length,
      message,
    });
    log.debug(message, { width: input.width, format: input.format });
  }
  return {
    file: input.file,
    width: input.width,
    format: input.format,
    optimized: true,
  };
}

async function syncAccount(
  input: SyncAccountInput,
  { attempt, reportProgress, log, signal }: JobContext,
  failedOnceJobs: Set<string>,
  jobId: string,
) {
  log.info("Fetching account changes", { account: input.account, attempt });
  await wait(300, signal);
  await reportProgress({ completed: 1, total: 3, message: "Fetched changes" });
  if (input.failOnce && !failedOnceJobs.has(jobId)) {
    failedOnceJobs.add(jobId);
    log.error("Upstream returned a retryable error", { code: "SYNC_503" });
    throw new Error("Upstream sync is temporarily unavailable");
  }
  await wait(340, signal);
  await reportProgress({ completed: 2, total: 3, message: "Validated" });
  await wait(360, signal);
  await reportProgress({ completed: 3, total: 3, message: "Committed" });
  log.info("Account sync committed", { account: input.account, records: 24 });
  return { account: input.account, records: 24 };
}

export function createPlaygroundQueue() {
  const failedOnceJobs = new Set<string>();
  return enqiu(
    {
      sendEmail,
      resizeImage,
      syncAccount: (
        input: SyncAccountInput,
        context: JobContext,
      ) => syncAccount(input, context, failedOnceJobs, context.id),
    },
    {
      name: "playground",
      worker: { concurrency: 2 },
      historyLimit: 80,
      logLimit: 80,
    },
  );
}

export type PlaygroundQueue = ReturnType<typeof createPlaygroundQueue>;

export function defaultDraft(recipeId: RecipeId = "sendEmail"): ComposerDraft {
  const recipe = recipeMap.get(recipeId);
  if (!recipe) throw new PlaygroundInputError(`Unknown recipe: ${recipeId}`);
  return {
    recipe: recipeId,
    payload: JSON.stringify(recipe.defaultPayload, null, 2),
    priority: "normal",
    delayMs: 0,
    retryAttempts: 1,
    failOnce: false,
  };
}

function describeJsonError(error: SyntaxError, source: string): string {
  const position = Number(error.message.match(/position\s+(\d+)/i)?.[1]);
  if (!Number.isFinite(position)) {
    return `Input must be valid JSON: ${error.message}`;
  }
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = position - lastNewline;
  return `Input must be valid JSON at line ${line}, column ${column}.`;
}

export function parsePayload(
  recipeId: RecipeId,
  source: string,
): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new PlaygroundInputError(
      error instanceof SyntaxError
        ? describeJsonError(error, source)
        : "Input must be valid JSON.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlaygroundInputError("Input must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  if (recipeId === "sendEmail") {
    if (typeof input.to !== "string" || !input.to.includes("@")) {
      throw new PlaygroundInputError('sendEmail requires a valid string field named "to".');
    }
    if (typeof input.subject !== "string" || input.subject.length === 0) {
      throw new PlaygroundInputError('sendEmail requires a non-empty string field named "subject".');
    }
  }
  if (recipeId === "resizeImage") {
    if (typeof input.file !== "string" || input.file.length === 0) {
      throw new PlaygroundInputError('resizeImage requires a string field named "file".');
    }
    if (typeof input.width !== "number" || input.width < 1) {
      throw new PlaygroundInputError('resizeImage requires a positive number field named "width".');
    }
    if (!new Set(["webp", "avif", "png"]).has(String(input.format))) {
      throw new PlaygroundInputError('resizeImage format must be "webp", "avif", or "png".');
    }
  }
  if (recipeId === "syncAccount") {
    if (typeof input.account !== "string" || input.account.length === 0) {
      throw new PlaygroundInputError('syncAccount requires a string field named "account".');
    }
  }
  return input;
}

function submitOptions(draft: ComposerDraft): SubmitOptions {
  return {
    ...(draft.customId?.trim() ? { id: draft.customId.trim() } : {}),
    ...(draft.idempotencyKey?.trim()
      ? { idempotencyKey: draft.idempotencyKey.trim() }
      : {}),
    priority: draft.priority,
    ...(draft.delayMs > 0 ? { delay: draft.delayMs } : {}),
    retry: { attempts: draft.retryAttempts },
    ...(draft.timeoutMs !== undefined ? { timeout: draft.timeoutMs } : {}),
    ...(draft.expiresInMs !== undefined
      ? { expiresIn: draft.expiresInMs }
      : {}),
  };
}

export async function submitDraft(
  queue: PlaygroundQueue,
  draft: ComposerDraft,
): Promise<SubmittedJob> {
  const parsed = parsePayload(draft.recipe, draft.payload);
  const options = submitOptions(draft);
  let handle: JobHandle;
  if (draft.recipe === "sendEmail") {
    handle = await queue.sendEmail(parsed as unknown as SendEmailInput, options);
  } else if (draft.recipe === "resizeImage") {
    handle = await queue.resizeImage(parsed as unknown as ResizeImageInput, options);
  } else {
    handle = await queue.syncAccount(
      { ...(parsed as unknown as SyncAccountInput), failOnce: draft.failOnce },
      options,
    );
  }
  void handle.result.catch(() => undefined);
  return { handle, input: parsed };
}

export function recipeFor(id: RecipeId): Recipe {
  const recipe = recipeMap.get(id);
  if (!recipe) throw new PlaygroundInputError(`Unknown recipe: ${id}`);
  return recipe;
}
