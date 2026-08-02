import { afterEach, describe, expect, it } from "vitest";
import { createJobs } from "./jobs.js";

let jobs: ReturnType<typeof createJobs> | undefined;

afterEach(async () => {
  await jobs?.worker.close();
  jobs = undefined;
});

describe("email jobs with the memory driver", () => {
  it("returns and stores the handler result", async () => {
    jobs = createJobs();
    const handle = await jobs.sendWelcome({ name: "Ada" });

    await expect(handle.result).resolves.toEqual({ subject: "Welcome, Ada" });
    expect((await handle.refresh()).status).toBe("succeeded");
  });
});
