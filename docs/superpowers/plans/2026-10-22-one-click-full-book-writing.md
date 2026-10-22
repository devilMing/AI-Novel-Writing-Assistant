# One-click Full-book Writing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在导演 V2 的规划完成状态增加“一键写作全文”入口，从首个未完成章节开始，沿用现有滚动规划、章节生成、审核、修复、状态提交与自动保存链路，一直写到已冻结的全书目标章数。

**Architecture:** 不创建新的写作引擎，也不并行生成章节。前端把现有 `open_run` 命令的授权范围扩展为“首个未完成章 → 目标总章数”，并强制使用 `driver: "auto"`；后端现有 `productionComposition` 会在范围终点等于目标章数时切换到 `full_book_autopilot`，`NovelPipelineExecutor` 再按章顺序执行 JIT 规划、正文、审核/修复、连续性状态提交和保存。现有章节、人工修改、幂等命令、暂停/恢复和失败保护全部继续生效。

**Tech Stack:** React 19、TypeScript、TanStack Query、Radix Dialog、Express、导演 V2 `open_run` 命令、Node test runner。

**实施状态（2026-10-22）：** 功能、命令契约、展示测试、后端范围契约、前后端构建及恢复测试已完成；浏览器实际点击验收按仓库规则留给用户执行。

---

## 现有能力与设计结论

现有代码已经具备全文自动写作所需的核心链路：

1. `server/src/modules/director/steps/planDefinition.ts` 定义固定顺序：
   `volume_beat_sheet → volume_chapter_list → chapter_detail_bundle → execution_contract_sync → chapter_batch`。
2. `server/src/app/director/productionComposition.ts` 在 `executionRange.to === estimatedChapterCount` 时，把流水线设为 `full_book_autopilot`。
3. `server/src/services/novel/production/NovelPipelineExecutor.ts` 按章节顺序运行，并在进入下一章前调用 `ChapterRouteWindowService.ensureRouteWindow`，滚动补足未来 3—5 章路线。
4. 每章依次执行正文生成、质量检查、自动修复、状态提交和产物同步；完成后更新 `generationJob.completedCount` 与持久化 payload。
5. `skipCompleted: true`、章节闭合检查和导演运行绑定已经提供断点恢复及防重复写作能力。

因此本功能只需要新增入口、确认交互和回归测试；不需要数据库迁移，不需要新 API，也不应复制任何章节生成逻辑。

## 文件结构

- Modify: `client/src/components/directorNext/DirectorStart.tsx`
  - 复用现有启动表单状态，新增全文范围计算、确认弹窗和全文命令提交。
- Modify: `client/tests/directorCommands.test.js`
  - 证明全文按钮提交的是现有 `open_run`，范围为首个未完成章到目标总章数，并强制全自动模式。
- Modify: `client/tests/directorNext.test.js`
  - 证明规划完成页展示入口、范围和自动保存说明，运行中不展示重复入口。
- Modify: `server/tests/directorNext/steps/productionComposition.test.js`
  - 固化后端已有契约：全文授权范围必须保留到目标章数，使用生产计划全部步骤且不覆盖已有正文。

不修改：

- `server/src/services/novel/production/NovelPipelineExecutor.ts`
- `server/src/services/novel/planning/ChapterRouteWindowService.ts`
- Prisma schema / migrations
- 环境变量与模型配置

### Task 1: 锁定全文启动命令契约

**Files:**
- Modify: `client/tests/directorCommands.test.js`

- [ ] **Step 1: 在测试打包入口导出全文启动练习函数**

在 `exerciseContinuation` 旁新增 `exerciseFullBookContinuation`。它使用与真实页面相同的 Query 缓存，并直接调用 `DirectorStart` 捕获到的 mutation：

```tsx
export async function exerciseFullBookContinuation() {
  useLLMStore.getState().setSelection({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    temperature: 0.7,
  });
  Object.assign(useLLMStore.getInitialState(), useLLMStore.getState());
  const posts = [];
  apiClient.defaults.adapter = async config => {
    posts.push(JSON.parse(config.data));
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      data: {success: true, data: {runId: 'full-book-run', controlVersion: 1}},
    };
  };
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  try {
    captured.length = 0;
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DirectorStart
            novelId="book"
            estimatedChapterCount={30}
            nextChapter={8}
            initialStory="朝堂权谋复仇"
            suggestedRange={{from: 8, to: 10}}
            initialDriver="assisted"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await captured.at(-1).mutationFn('full_book');
    return posts;
  } finally {
    client.clear();
  }
}
```

同时把动态导入解构扩展为：

```js
let exercise, exerciseContinuation, exerciseFullBookContinuation;

({exercise, exerciseContinuation, exerciseFullBookContinuation} = await import(pathToFileURL(output).href));
```

- [ ] **Step 2: 写失败断言**

```js
test('one-click full-book writing authorizes the remaining book through the existing automatic run', async () => {
  const posts = await exerciseFullBookContinuation();
  assert.equal(posts.length, 1);
  const {idempotencyKey, ...command} = posts[0];
  assert.ok(idempotencyKey);
  assert.deepEqual(command, {
    type: 'open_run',
    novelId: 'book',
    driver: 'auto',
    stepIdsInScope: null,
    launchInput: {
      storyInput: '朝堂权谋复仇',
      estimatedChapterCount: 30,
      worldMode: 'skip',
      targetMode: 'opening',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      temperature: 0.7,
      issuePolicyMode: 'completion_first',
      executionRange: {from: 8, to: 30},
    },
  });
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```powershell
node --test client/tests/directorCommands.test.js
```

Expected: FAIL；当前 mutation 不认识 `full_book`，仍提交建议范围或半自动模式。

- [ ] **Step 4: Commit 测试**

```powershell
git add client/tests/directorCommands.test.js
git commit -m "test: 锁定一键全文启动契约"
```

### Task 2: 在现有启动表单增加全文命令

**Files:**
- Modify: `client/src/components/directorNext/DirectorStart.tsx`
- Test: `client/tests/directorCommands.test.js`

- [ ] **Step 1: 引入确认弹窗组件并声明启动模式**

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type DirectorStartMode = "selected_range" | "full_book";
```

- [ ] **Step 2: 把现有 mutation 改为接收启动模式**

保留当前表单校验和 Query 失效逻辑，仅集中计算授权范围：

```tsx
const fullBookFrom = suggestedRange?.from ?? nextChapter;
const canWriteFullBook = Boolean(suggestedRange)
  && Number.isInteger(count)
  && fullBookFrom >= 1
  && fullBookFrom <= count;

const mutation = useMutation({
  mutationFn: async (mode: DirectorStartMode = "selected_range") => {
    if (!story.trim() || !model.provider || !model.model || !Number.isInteger(count) || count < 1) {
      throw new Error("请填写故事方向、目标章数并选择模型。");
    }
    const executionRange = mode === "full_book"
      ? {from: fullBookFrom, to: count}
      : production
        ? {from, to}
        : undefined;
    if (executionRange && (
      !Number.isInteger(executionRange.from)
      || !Number.isInteger(executionRange.to)
      || executionRange.from < 1
      || executionRange.to < executionRange.from
      || executionRange.to > count
    )) {
      throw new Error("请填写目标章数以内的有效章节范围。");
    }
    return submitDirectorCommand({
      type: "open_run",
      novelId,
      driver: mode === "full_book" ? "auto" : assisted ? "assisted" : "auto",
      stepIdsInScope: null,
      idempotencyKey: createDirectorCommandKey(),
      launchInput: {
        storyInput: story.trim(),
        estimatedChapterCount: count,
        worldMode: world,
        targetMode: "opening",
        provider: model.provider,
        model: model.model,
        temperature: model.temperature,
        issuePolicyMode: qualityFirst ? "quality_first" : "completion_first",
        ...(executionRange ? {executionRange} : {}),
      },
    });
  },
  onSuccess: async () => {
    await Promise.all([
      queries.invalidateQueries({queryKey: queryKeys.directorNext.summary(novelId)}),
      queries.invalidateQueries({queryKey: queryKeys.directorNext.detail(novelId)}),
    ]);
  },
});
```

现有提交按钮改成显式调用：

```tsx
onClick={() => mutation.mutate("selected_range")}
```

- [ ] **Step 3: 增加“一键写作全文”确认入口**

只在存在后续未完成范围时展示：

```tsx
{canWriteFullBook ? (
  <div className="space-y-2">
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="w-full" disabled={mutation.isPending}>
          一键写作全文
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>从第 {fullBookFrom} 章自动写到第 {count} 章？</DialogTitle>
          <DialogDescription>
            将沿用已有规划和写作顺序，逐章补齐路线、章节任务、正文、审核与修复，并在每章完成后自动保存。已有正文不会被覆盖。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          模式：全自动推进 · 模型：{model.model} · 范围：第 {fullBookFrom}—{count} 章
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("full_book")}
          >
            {mutation.isPending ? "启动中…" : "确认并开始全文写作"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <p className="text-xs text-muted-foreground">
      第 {fullBookFrom}—{count} 章 · 按既有顺序逐章补齐路线、章节任务、正文、审核与修复，每章完成后自动保存。
    </p>
  </div>
) : null}
```

- [ ] **Step 4: 运行命令测试并确认 GREEN**

Run:

```powershell
node --test client/tests/directorCommands.test.js
```

Expected: PASS；全文命令为 `driver: "auto"`，范围为 `{from: 8, to: 30}`。

- [ ] **Step 5: Commit**

```powershell
git add client/src/components/directorNext/DirectorStart.tsx client/tests/directorCommands.test.js
git commit -m "feat: 增加一键全文写作入口"
```

### Task 3: 固化导演台展示行为

**Files:**
- Modify: `client/tests/directorNext.test.js`
- Modify: `client/src/components/directorNext/DirectorStart.tsx`

- [ ] **Step 1: 为完成态增加 UI 断言**

在 `renderedProduction()` 的完成态断言旁新增：

```js
assert.match(production.completed, /一键写作全文/);
assert.match(production.completed, /第 4—12 章/);
assert.match(production.completed, /逐章补齐路线、章节任务、正文、审核与修复/);
assert.match(production.completed, /每章完成后自动保存/);
```

运行态必须继续隐藏启动区域：

```js
assert.doesNotMatch(production.running, /一键写作全文/);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
node --test client/tests/directorNext.test.js
```

Expected: FAIL；当前完成态没有全文按钮及确认说明。

- [ ] **Step 3: 调整确认文案使其准确呈现范围与保存行为**

确认 `DirectorStart.tsx` 中按钮下方的常驻说明（不是关闭状态下不会渲染的 Dialog 内容）包含：

```tsx
第 {fullBookFrom}—{count} 章
```

以及：

```tsx
逐章补齐路线、章节任务、正文、审核与修复，并在每章完成后自动保存。
```

- [ ] **Step 4: 运行 UI 测试并确认 GREEN**

Run:

```powershell
node --test client/tests/directorNext.test.js
```

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
git add client/src/components/directorNext/DirectorStart.tsx client/tests/directorNext.test.js
git commit -m "test: 覆盖全文写作入口展示"
```

### Task 4: 固化后端已有全文生产边界

**Files:**
- Modify: `server/tests/directorNext/steps/productionComposition.test.js`

- [ ] **Step 1: 增加全文运行契约测试**

在现有 `real production composition...` 测试之后增加：

```js
test('a full-book continuation keeps the remaining range and all production steps', () => {
  const fullBook = options.contractFactory({
    runId: 'full-book',
    novelId: 'novel',
    driver: 'auto',
    stepIdsInScope: null,
    launchInput: {
      ...launchInput,
      estimatedChapterCount: 30,
      executionRange: {from: 8, to: 30},
    },
  });
  assert.equal(fullBook.driver, 'auto');
  assert.deepEqual(fullBook.chapterRange, {from: 8, to: 30});
  assert.equal(fullBook.scope, 'chapters:8-30');
  assert.equal(fullBook.stepIdsInScope, null);
  assert.ok(options.plan.steps.some(step => step.id === 'chapter_detail_bundle'));
  assert.ok(options.plan.steps.some(step => step.id === 'execution_contract_sync'));
  assert.ok(options.plan.steps.some(step => step.id === 'chapter_batch'));
});
```

该测试不新增后端行为，只防止未来有人把全文入口错误地降级为“只写一章”或“只做规划”。

- [ ] **Step 2: 构建服务端并运行测试**

Run:

```powershell
pnpm --filter @ai-novel/server build
node --test server/tests/directorNext/steps/productionComposition.test.js server/tests/directorNext/steps/pipelineBridge.test.js
```

Expected: PASS，且 `pipelineBridge` 继续证明导演自动写作不会越过授权终点。

- [ ] **Step 3: Commit**

```powershell
git add server/tests/directorNext/steps/productionComposition.test.js
git commit -m "test: 固化全文自动写作范围"
```

### Task 5: 完整验证与运行验收

**Files:**
- Verify only

- [ ] **Step 1: 运行前端类型检查与目标测试**

Run:

```powershell
pnpm --filter @ai-novel/client build
node --test client/tests/directorCommands.test.js client/tests/directorNext.test.js
```

Expected: build exit 0；所有目标测试通过。

- [ ] **Step 2: 运行后端构建与全文链路回归测试**

Run:

```powershell
pnpm --filter @ai-novel/server build
node --test server/tests/directorNext/steps/productionComposition.test.js server/tests/directorNext/steps/pipelineBridge.test.js server/tests/directorNext/application/processRecoverySqlite.test.js
```

Expected: build exit 0；全文范围、授权边界和进程恢复测试通过。

- [ ] **Step 3: 重启独立后台后端任务**

Run:

```powershell
Stop-ScheduledTask -TaskName 'AI-Novel-Writing-Assistant-Server'
Start-ScheduledTask -TaskName 'AI-Novel-Writing-Assistant-Server'
```

等待健康接口返回成功：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 10
```

Expected: `success: true` 且 `status: ok`。

- [ ] **Step 4: 浏览器验收**

1. 打开一部导演 V2 且规划已完成的小说。
2. 确认原“选择并继续写第 X—Y 章”表单仍可用。
3. 确认新增“一键写作全文”按钮。
4. 打开确认框，核对显示的起止章节、模型、全自动模式和自动保存说明。
5. 确认后观察运行状态依次出现滚动规划、写作、检查、修复、保存。
6. 等第一章完成后刷新页面，确认正文已保存，进度从下一章继续。
7. 停止并重启后端，再确认任务从最近保存章节恢复，不重复覆盖已闭合正文。

- [ ] **Step 5: 核对仓库并提交最终结果**

```powershell
git diff --check
git status --short
git log -4 --oneline
```

Expected: 没有空白错误；只有本计划列出的文件发生变化。

## 验收标准

- 规划完成且还有未写章节时显示“一键写作全文”。
- 确认框明确显示起始章、目标章、模型、全自动模式和逐章自动保存。
- 提交仍走 `/director-next/commands` 的 `open_run`，不新建旁路 API。
- 全文范围从投影给出的首个未完成章开始，到被冻结的 `estimatedChapterCount` 结束。
- 全文命令强制 `driver: "auto"`；普通分段写作仍保留原有半自动/全自动选择。
- 已保存且完成闭合的章节被跳过，不覆盖用户正文。
- 每章继续沿用 JIT 路线、任务单、正文、检查、修复、状态提交和自动保存顺序。
- 暂停、取消、失败、断点恢复和幂等保护沿用现有运行时。
- 不修改电脑环境变量，不新增数据库迁移。

## 非目标

- 不并行生成多章正文。
- 不绕过质量检查、连续性提交或角色/伏笔同步。
- 不自动覆盖已有但尚未闭合的人工正文。
- 不改变模型、推理强度、质量策略或目标总章数。
- 不新增第二套全文任务表或后台调度器。

