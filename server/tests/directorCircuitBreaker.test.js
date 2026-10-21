const assert = require("node:assert/strict");
const test = require("node:test");

const {
  recordUsageAnomalySignal,
} = require("../dist/services/novel/director/runtime/DirectorCircuitBreakerService.js");
const {
  buildFailureCircuitBreaker,
  resolveUsageCircuitBreaker,
} = require("../dist/services/novel/director/automation/novelDirectorAutoExecutionCircuitBreakerRuntime.js");
const {
  directorUsageTelemetryQueryService,
} = require("../dist/services/novel/director/runtime/DirectorUsageTelemetryQueryService.js");

test("pipeline failures remain runtime failures when automatic repair is enabled", () => {
  const state = buildFailureCircuitBreaker({
    autoExecution: {
      autoRepair: true,
      nextChapterId: "chapter-1",
      nextChapterOrder: 1,
      circuitBreaker: null,
    },
    jobStatus: "failed",
    message: "模型服务暂时不可用。",
  });

  assert.equal(state.reason, "service_unavailable");
  assert.equal(state.patchFailureCount, 0);
});

test("usage anomaly ignores the same usage record twice", () => {
  let state = recordUsageAnomalySignal({
    previous: null,
    usageRecordId: "usage-1",
    totalTokens: 180000,
    nodeKey: "chapter_execution_node",
  });
  assert.equal(state.status, "closed");
  assert.equal(state.usageAnomalyCount, 1);

  state = recordUsageAnomalySignal({
    previous: state,
    usageRecordId: "usage-1",
    totalTokens: 180000,
    nodeKey: "chapter_execution_node",
  });
  assert.equal(state.status, "closed");
  assert.equal(state.usageAnomalyCount, 1);

  state = recordUsageAnomalySignal({
    previous: state,
    usageRecordId: "usage-2",
    totalTokens: 180000,
    nodeKey: "chapter_execution_node",
  });
  assert.equal(state.status, "open");
  assert.equal(state.reason, "usage_anomaly");
});

test("aggregate chapter usage does not open a quota circuit breaker", async () => {
  const originalLargest = directorUsageTelemetryQueryService.getLargestChapterUsage;
  const originalBook = directorUsageTelemetryQueryService.getBookUsage;
  directorUsageTelemetryQueryService.getLargestChapterUsage = async () => ({
    chapterId: "chapter-1",
    totalTokens: 120000,
    latestUsageRecordId: "chapter-usage-1",
    nodeKey: "chapter_execution_node",
  });
  directorUsageTelemetryQueryService.getBookUsage = async () => ({ recentUsage: [] });
  try {
    const state = await resolveUsageCircuitBreaker({
      taskId: "task-1",
      novelId: "novel-1",
      autoExecution: {
        nextChapterId: "chapter-1",
        nextChapterOrder: 1,
        remainingChapterIds: ["chapter-1"],
        circuitBreaker: null,
      },
    });
    assert.equal(state, null);
  } finally {
    directorUsageTelemetryQueryService.getLargestChapterUsage = originalLargest;
    directorUsageTelemetryQueryService.getBookUsage = originalBook;
  }
});
