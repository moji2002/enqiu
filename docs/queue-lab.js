import { enqiu } from "./enqiu/index.js";

const queueLab = document.querySelector("#queue-lab");
const queueTrack = document.querySelector("#queue-track");
const jobToken = document.querySelector("#job-token");
const jobStatus = document.querySelector("#job-status");
const jobResult = document.querySelector("#job-result");
const runButton = document.querySelector("#run-job");
const resetButton = document.querySelector("#queue-reset");
const stageLabels = [...document.querySelectorAll("[data-stage]")];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

if (
  !queueLab ||
  !queueTrack ||
  !jobToken ||
  !jobStatus ||
  !jobResult ||
  !runButton ||
  !resetButton
) {
  throw new Error("Queue Lab markup is incomplete");
}

const sleep = (duration, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const jobs = enqiu(
  {
    sendEmail: async ({ to }, context) => {
      await sleep(reducedMotion.matches ? 0 : 480, context.signal);
      await context.reportProgress({
        completed: 1,
        total: 2,
        message: "Connected to mail provider",
      });

      await sleep(reducedMotion.matches ? 0 : 620, context.signal);
      await context.reportProgress({
        completed: 2,
        total: 2,
        message: "Message accepted",
      });

      await sleep(reducedMotion.matches ? 0 : 320, context.signal);
      return {
        delivered: true,
        id: context.id.split(":").at(-1),
        to,
      };
    },
  },
  {
    name: "playground",
    worker: false,
    historyLimit: 8,
  },
);

let activeId;
let activeHandle;
let runSequence = 0;

const setStage = (state, status, result, progress) => {
  queueLab.dataset.state = state;
  queueTrack.dataset.state = state;
  jobToken.dataset.state = state;
  jobStatus.textContent = status;
  jobResult.textContent = result;
  queueTrack.style.setProperty("--job-progress", `${progress}%`);

  stageLabels.forEach((label) => {
    if (label.dataset.stage === state) {
      label.setAttribute("aria-current", "step");
    } else {
      label.removeAttribute("aria-current");
    }
  });
};

const matchesActive = (job) => job.id === activeId;

jobs.queue.on("added", (job) => {
  if (!matchesActive(job)) return;
  setStage("queued", "Accepted by Enqiu", `Job ${job.id} is queued`, 12);
});

jobs.queue.on("started", (job) => {
  if (!matchesActive(job)) return;
  setStage("working", `Running attempt ${job.attempt}`, "Handler started", 28);
});

jobs.queue.on("progress", (job) => {
  if (!matchesActive(job)) return;
  const progress = job.progress ?? {};
  const completed = Number(progress.completed ?? 0);
  const total = Math.max(1, Number(progress.total ?? 1));
  const percent = Math.round((completed / total) * 100);
  setStage(
    "working",
    progress.message ?? "Handler is working",
    `${completed} of ${total} steps complete`,
    percent,
  );
});

jobs.queue.on("succeeded", (job) => {
  if (!matchesActive(job)) return;
  const duration = Math.max(1, (job.finishedAt ?? Date.now()) - (job.startedAt ?? Date.now()));
  setStage(
    "complete",
    `Succeeded in ${duration}ms`,
    JSON.stringify(job.output),
    100,
  );
  runButton.textContent = "Run again";
});

jobs.queue.on("failed", (job) => {
  if (!matchesActive(job)) return;
  setStage("queued", "Handler failed", job.error?.message ?? "Job failed", 0);
  runButton.textContent = "Try again";
});

jobs.queue.on("cancelled", (job) => {
  if (!matchesActive(job)) return;
  setStage("queued", "Run cancelled", "Ready for another job", 0);
});

const resetLab = async () => {
  runSequence += 1;
  if (activeHandle) {
    await activeHandle.cancel("Playground reset");
  }
  await jobs.worker.pause();
  activeHandle = undefined;
  activeId = undefined;
  setStage("queued", "Ready to run", "Powered by the real Enqiu memory driver", 0);
  runButton.textContent = "Run sendEmail()";
};

const runJob = async () => {
  const currentRun = ++runSequence;
  if (activeHandle) {
    await activeHandle.cancel("Replaced by a new playground run");
  }
  if (currentRun !== runSequence) return;

  await jobs.worker.pause();
  const id = `playground:sendEmail:${Date.now().toString(36)}-${currentRun}`;
  activeId = id;
  runButton.textContent = "Queued…";

  const handle = await jobs.sendEmail(
    { to: "you@example.com" },
    { id },
  );
  activeHandle = handle;

  await sleep(reducedMotion.matches ? 0 : 420);
  if (currentRun !== runSequence) return;

  runButton.textContent = "Running…";
  await jobs.worker.start();

  try {
    await handle.result;
  } catch (error) {
    if (currentRun === runSequence && handle.status !== "cancelled") {
      setStage(
        "queued",
        "Could not run the job",
        error instanceof Error ? error.message : "Unknown queue error",
        0,
      );
      runButton.textContent = "Try again";
    }
  } finally {
    if (currentRun === runSequence) {
      await jobs.worker.pause();
    }
  }
};

runButton.addEventListener("click", () => void runJob());
resetButton.addEventListener("click", () => void resetLab());

window.__enqiuPlayground = Object.freeze({
  run: runJob,
  reset: resetLab,
  stats: () => jobs.queue.stats(),
});

setStage(
  "queued",
  "Ready to run",
  "Powered by the real Enqiu memory driver",
  0,
);
