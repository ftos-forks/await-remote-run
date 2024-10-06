import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  fetchWorkflowRunActiveJobUrl,
  fetchWorkflowRunActiveJobUrlRetry,
  fetchWorkflowRunFailedJobs,
  fetchWorkflowRunState,
  init,
  retryOnError,
} from "./api.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";

vi.mock("@actions/core");
vi.mock("@actions/github");

interface MockResponse {
  data: any;
  status: number;
}

const mockOctokit = {
  rest: {
    actions: {
      getWorkflowRun: (_req?: any): Promise<MockResponse> => {
        throw new Error("Should be mocked");
      },
      listJobsForWorkflowRun: (_req?: any): Promise<MockResponse> => {
        throw new Error("Should be mocked");
      },
    },
  },
};

describe("API", () => {
  const cfg = {
    token: "secret",
    ref: "feature_branch",
    repo: "repository",
    owner: "owner",
    runId: 123456,
    runTimeoutSeconds: 300,
    pollIntervalMs: 2500,
  };

  const { coreWarningLogMock, assertOnlyCalled, assertNoneCalled } =
    mockLoggingFunctions();

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(core, "getInput").mockReturnValue("");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.spyOn(github, "getOctokit").mockReturnValue(mockOctokit as any);
    init(cfg);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("fetchWorkflowRunState", () => {
    it("should return the workflow run state for a given run ID", async () => {
      const mockData = {
        status: "completed",
        conclusion: "cancelled",
      };
      vi.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockReturnValue(
        Promise.resolve({
          data: mockData,
          status: 200,
        }),
      );

      const state = await fetchWorkflowRunState(123456);
      expect(state.conclusion).toStrictEqual(mockData.conclusion);
      expect(state.status).toStrictEqual(mockData.status);
    });

    it("should throw if a non-200 status is returned", async () => {
      const errorStatus = 401;
      vi.spyOn(mockOctokit.rest.actions, "getWorkflowRun").mockReturnValue(
        Promise.resolve({
          data: undefined,
          status: errorStatus,
        }),
      );

      await expect(fetchWorkflowRunState(0)).rejects.toThrow(
        `Failed to fetch Workflow Run state, expected 200 but received ${errorStatus}`,
      );
    });
  });

  describe("fetchWorkflowRunJobs", () => {
    const mockData = {
      total_count: 1,
      jobs: [
        {
          id: 123456789,
          html_url: "https://github.com/codex-/await-remote-run/runs/123456789",
          status: "completed",
          conclusion: "failure",
          name: "test-run",
          steps: [
            {
              name: "Step 1",
              status: "completed",
              conclusion: "success",
              number: 1,
            },
            {
              name: "Step 2",
              status: "completed",
              conclusion: "failure",
              number: 6,
            },
          ],
        },
      ],
    };

    describe("fetchWorkflowRunFailedJobs", () => {
      it("should return the jobs for a failed workflow run given a run ID", async () => {
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: mockData,
            status: 200,
          }),
        );

        const jobs = await fetchWorkflowRunFailedJobs(123456);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.id).toStrictEqual(mockData.jobs[0]?.id);
        expect(jobs[0]?.name).toStrictEqual(mockData.jobs[0]?.name);
        expect(jobs[0]?.status).toStrictEqual(mockData.jobs[0]?.status);
        expect(jobs[0]?.conclusion).toStrictEqual(mockData.jobs[0]?.conclusion);
        expect(jobs[0]?.url).toStrictEqual(mockData.jobs[0]?.html_url);
        expect(Array.isArray(jobs[0]?.steps)).toStrictEqual(true);
      });

      it("should throw if a non-200 status is returned", async () => {
        const errorStatus = 401;
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: undefined,
            status: errorStatus,
          }),
        );

        await expect(fetchWorkflowRunFailedJobs(0)).rejects.toThrow(
          `Failed to fetch Jobs for Workflow Run, expected 200 but received ${errorStatus}`,
        );
      });

      it("should return the steps for a failed Job", async () => {
        const mockSteps = mockData.jobs[0]!.steps;
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: mockData,
            status: 200,
          }),
        );

        const { steps } = (await fetchWorkflowRunFailedJobs(123456))[0]!;
        expect(steps).toHaveLength(mockData.jobs[0]!.steps.length);
        for (let i = 0; i < mockSteps.length; i++) {
          expect(steps[i]?.name).toStrictEqual(mockSteps[i]?.name);
          expect(steps[i]?.number).toStrictEqual(mockSteps[i]?.number);
          expect(steps[i]?.status).toStrictEqual(mockSteps[i]?.status);
          expect(steps[i]?.conclusion).toStrictEqual(mockSteps[i]?.conclusion);
        }
      });
    });

    describe("fetchWorkflowRunActiveJobUrl", () => {
      let inProgressMockData: any;

      beforeEach(() => {
        inProgressMockData = {
          ...mockData,
          jobs: [
            {
              ...mockData.jobs[0],
              status: "in_progress",
              conclusion: null,
            },
          ],
        };
      });

      it("should return the url for an in_progress workflow run given a run ID", async () => {
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
          }),
        );

        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(mockData.jobs[0]?.html_url);
      });

      it("should return the url for an completed workflow run given a run ID", async () => {
        inProgressMockData.jobs[0].status = "completed";

        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
          }),
        );

        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(mockData.jobs[0]?.html_url);
      });

      it("should throw if a non-200 status is returned", async () => {
        const errorStatus = 401;
        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: undefined,
            status: errorStatus,
          }),
        );

        await expect(fetchWorkflowRunActiveJobUrl(0)).rejects.toThrow(
          `Failed to fetch Jobs for Workflow Run, expected 200 but received ${errorStatus}`,
        );
      });

      it("should return undefined if no in_progress job is found", async () => {
        inProgressMockData.jobs[0].status = "unknown";

        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
          }),
        );

        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual(undefined);
      });

      it("should return even if GitHub fails to return a URL", async () => {
        inProgressMockData.jobs[0].html_url = null;

        vi.spyOn(
          mockOctokit.rest.actions,
          "listJobsForWorkflowRun",
        ).mockReturnValue(
          Promise.resolve({
            data: inProgressMockData,
            status: 200,
          }),
        );

        const url = await fetchWorkflowRunActiveJobUrl(123456);
        expect(url).toStrictEqual("GitHub failed to return the URL");
      });

      describe("fetchWorkflowRunActiveJobUrlRetry", () => {
        beforeEach(() => {
          vi.useFakeTimers();
        });

        afterEach(() => {
          vi.useRealTimers();
        });

        it("should return a message if no job is found", async () => {
          inProgressMockData.jobs[0].status = "unknown";

          vi.spyOn(
            mockOctokit.rest.actions,
            "listJobsForWorkflowRun",
          ).mockReturnValue(
            Promise.resolve({
              data: inProgressMockData,
              status: 200,
            }),
          );

          const urlPromise = fetchWorkflowRunActiveJobUrlRetry(123456, 100);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const url = await urlPromise;
          expect(url).toStrictEqual("Unable to fetch URL");
        });

        it("should return a message if no job is found within the timeout period", async () => {
          vi.spyOn(mockOctokit.rest.actions, "listJobsForWorkflowRun")
            // Final
            .mockImplementation(() => {
              inProgressMockData.jobs[0].status = "in_progress";

              return Promise.resolve({
                data: inProgressMockData,
                status: 200,
              });
            })
            // First
            .mockImplementationOnce(() => {
              inProgressMockData.jobs[0].status = "unknown";

              return Promise.resolve({
                data: inProgressMockData,
                status: 200,
              });
            })
            // Second
            .mockImplementationOnce(() =>
              Promise.resolve({
                data: inProgressMockData,
                status: 200,
              }),
            );

          const urlPromise = fetchWorkflowRunActiveJobUrlRetry(123456, 200);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const url = await urlPromise;
          expect(url).toStrictEqual("Unable to fetch URL");
        });

        it("should return a URL if an in_progress job is found", async () => {
          vi.spyOn(
            mockOctokit.rest.actions,
            "listJobsForWorkflowRun",
          ).mockImplementation(() =>
            Promise.resolve({
              data: inProgressMockData,
              status: 200,
            }),
          );

          const urlPromise = fetchWorkflowRunActiveJobUrlRetry(123456, 200);
          vi.advanceTimersByTime(400);
          await vi.advanceTimersByTimeAsync(400);

          const url = await urlPromise;
          expect(url).toStrictEqual(inProgressMockData.jobs[0]?.html_url);
        });
      });
    });
  });

  describe("retryOnError", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return a success result", async () => {
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(() => Promise.resolve("completed"));

      const result = await retryOnError(() => testFunc(), 5000);

      if (!result.success) {
        expect.fail();
      }

      expect(result.success).toStrictEqual(true);
      expect(result.value).toStrictEqual("completed");
      assertNoneCalled();
    });

    it("should retry a function if it throws an error", async () => {
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(() => Promise.resolve("completed"))
        .mockImplementationOnce(() => Promise.reject(Error(errorMsg)));

      const retryPromise = retryOnError(testFunc, 5000);

      // Progress timers to first failure
      await vi.advanceTimersByTimeAsync(1000);

      assertOnlyCalled(coreWarningLogMock);
      expect(coreWarningLogMock).toHaveBeenCalledOnce();
      expect(coreWarningLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
        "retryOnError: An unexpected error has occurred:
          name: spy
          error: some error"
      `);
      expect(coreWarningLogMock.mock.calls[0]?.[0]).toContain(testFunc.name);
      coreWarningLogMock.mockReset();

      // Progress timers to second success
      await vi.advanceTimersByTimeAsync(1000);

      const result = await retryPromise;

      if (!result.success) {
        expect.fail();
      }

      assertNoneCalled();
      expect(result.success).toStrictEqual(true);
      expect(result.value).toStrictEqual("completed");
    });

    it("should display a fallback function name if none is available", async () => {
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(() => Promise.reject(Error(errorMsg)));

      // Use anonymous function
      const retryPromise = retryOnError(() => testFunc(), 5000);

      // Progress timers to first failure
      await vi.advanceTimersByTimeAsync(1000);

      assertOnlyCalled(coreWarningLogMock);
      expect(coreWarningLogMock).toHaveBeenCalledOnce();
      expect(coreWarningLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
        "retryOnError: An unexpected error has occurred:
          name: anonymous function
          error: some error"
      `);
      coreWarningLogMock.mockReset();

      // Clean up promise
      await retryPromise;
    });

    it("should return a timeout result", async () => {
      const errorMsg = "some error";
      const testFunc = vi
        .fn<() => Promise<string>>()
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          throw new Error(errorMsg);
        });

      const retryPromise = retryOnError(() => testFunc(), 500);

      await vi.advanceTimersByTimeAsync(2000);

      const result = await retryPromise;

      if (result.success) {
        expect.fail();
      }

      expect(result.success).toStrictEqual(false);
      expect(result.reason).toStrictEqual("timeout");
      assertNoneCalled();
    });
  });
});
