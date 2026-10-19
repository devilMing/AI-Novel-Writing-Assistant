import type {
  CompleteQuickSetupRequest,
  CompleteQuickSetupResult,
  QuickSetupProviderOption,
  QuickSetupStatus,
} from "@ai-novel/shared/types/onboarding";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { ModelRouteTaskType } from "@ai-novel/shared/types/novel";
import { setProviderSecretCache } from "../../../../llm/factory";
import { llmConnectivityService } from "../../../../llm/connectivity";
import {
  MODEL_ROUTE_TASK_TYPES,
  resolveModel,
  upsertModelRouteConfig,
} from "../../../../llm/modelRouter";
import { evictSharedLimiters } from "../../../../llm/requestLimiter";
import { normalizeReasoningEffort } from "../../../../llm/reasoning";
import {
  getProviderEnvApiKey,
  getProviderEnvBaseUrl,
  getProviderEnvModel,
  isBuiltInProvider,
  providerRequiresApiKey,
  PROVIDERS,
  SUPPORTED_PROVIDERS,
} from "../../../../llm/providers";
import { AppError } from "../../../../middleware/errorHandler";
import {
  getLLMSelectionSettings,
  saveLLMSelectionSettings,
} from "../../../../services/settings/LLMSelectionSettingsService";
import { secretStore } from "../../../../services/settings/secretStore";
import { chatGPTAuthService } from "../../chatgpt-auth/application/ChatGPTAuthService";
import { serializeModelList } from "../../../../llm/modelCatalog";

const ROUTE_TEMPERATURES: Record<ModelRouteTaskType, number> = {
  planner: 0.3,
  writer: 0.8,
  review: 0.2,
  light_review: 0.2,
  critical_review: 0.1,
  repair: 0.4,
  replan: 0.2,
  state_resolution: 0.1,
  summary: 0.2,
  fact_extraction: 0.2,
  chat: 0.7,
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function buildCustomProviderId(name: string): LLMProvider {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `custom_${normalized || "provider"}`;
}

async function listProviderOptions(): Promise<QuickSetupProviderOption[]> {
  const [records, chatGPTStatus] = await Promise.all([
    secretStore.listProviders(),
    chatGPTAuthService.status().catch(() => ({ connected: false, models: [] })),
  ]);
  const recordByProvider = new Map(records.map((record) => [record.provider, record]));
  const builtins: QuickSetupProviderOption[] = SUPPORTED_PROVIDERS.map((provider) => {
    const config = PROVIDERS[provider];
    const record = recordByProvider.get(provider);
    const currentModel = normalizeOptionalText(record?.model)
      ?? getProviderEnvModel(provider)
      ?? config.defaultModel;
    const currentBaseURL = normalizeOptionalText(record?.baseURL)
      ?? getProviderEnvBaseUrl(provider)
      ?? config.baseURL;
    const usesChatGPTPlan = provider === "openai" && record?.authMode === "chatgpt_oauth";
    const hasRequiredKey = usesChatGPTPlan
      ? chatGPTStatus.connected
      : !providerRequiresApiKey(provider)
      || Boolean(normalizeOptionalText(record?.key) ?? getProviderEnvApiKey(provider));
    const chatGPTModels = provider === "openai"
      ? chatGPTStatus.models.map((item: { slug: string }) => item.slug)
      : [];
    return {
      id: provider,
      kind: "builtin",
      name: config.name,
      requiresApiKey: providerRequiresApiKey(provider),
      authMode: usesChatGPTPlan ? "chatgpt_oauth" : "bearer",
      configured: (record?.isActive ?? true) && hasRequiredKey && Boolean(currentModel),
      active: record?.isActive ?? true,
      currentModel,
      defaultModel: config.defaultModel,
      currentBaseURL,
      defaultBaseURL: config.baseURL,
      currentReasoningEffort: normalizeReasoningEffort(record?.reasoningEffort),
      models: Array.from(new Set([...chatGPTModels, ...(config.models ?? []), currentModel].filter(Boolean))),
    };
  });
  const customs: QuickSetupProviderOption[] = records
    .filter((record) => !isBuiltInProvider(record.provider))
    .map((record) => {
      const currentModel = normalizeOptionalText(record.model) ?? "";
      const currentBaseURL = normalizeOptionalText(record.baseURL) ?? "";
      return {
        id: record.provider,
        kind: "custom",
        name: normalizeOptionalText(record.displayName) ?? record.provider,
        requiresApiKey: false,
        authMode: record.authMode === "x-api-key" || record.authMode === "none" ? record.authMode : "bearer",
        configured: record.isActive && Boolean(currentModel && currentBaseURL),
        active: record.isActive,
        currentModel,
        defaultModel: currentModel,
        currentBaseURL,
        defaultBaseURL: currentBaseURL,
        currentReasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
        models: currentModel ? [currentModel] : [],
      };
    });
  return [...builtins, ...customs];
}

export async function getQuickSetupStatus(): Promise<QuickSetupStatus> {
  const [providers, selection, resolvedRoutes] = await Promise.all([
    listProviderOptions(),
    getLLMSelectionSettings(),
    Promise.all(MODEL_ROUTE_TASK_TYPES.map(async (taskType) => ({
      taskType,
      route: await resolveModel(taskType),
    }))),
  ]);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const missingTaskTypes = resolvedRoutes
    .filter(({ route }) => {
      const provider = providerById.get(route.provider);
      return !provider?.configured || !route.model.trim();
    })
    .map(({ taskType }) => taskType);
  const plannerRoute = resolvedRoutes.find(({ taskType }) => taskType === "planner")?.route;
  const fallbackProvider = plannerRoute && providerById.get(plannerRoute.provider)?.configured
    ? providerById.get(plannerRoute.provider)
    : providers.find((provider) => provider.configured);
  const selectedProviderOption = selection && providerById.get(selection.provider)?.configured
    ? providerById.get(selection.provider)
    : fallbackProvider;
  const selectedProvider = selectedProviderOption?.id ?? null;
  const selectedModel = selection && selectedProvider === selection.provider
    ? selection.model
    : selectedProviderOption?.currentModel ?? null;
  const hasUsableSelection = Boolean(
    selectedModel?.trim()
    && selectedProviderOption?.configured,
  );
  const readyForCreation = hasUsableSelection && missingTaskTypes.length === 0;
  const blockingReasons: string[] = [];
  if (!hasUsableSelection) {
    blockingReasons.push("还没有可用于创作的默认文本模型。");
  }
  if (missingTaskTypes.length > 0) {
    blockingReasons.push(`还有 ${missingTaskTypes.length} 类创作任务没有可用模型路由。`);
  }
  return {
    readyForCreation,
    providers,
    selectedProvider,
    selectedModel,
    routeCoverage: {
      configured: MODEL_ROUTE_TASK_TYPES.length - missingTaskTypes.length,
      total: MODEL_ROUTE_TASK_TYPES.length,
      missingTaskTypes,
    },
    blockingReasons,
    recommendedAction: !hasUsableSelection
      ? "configure_provider"
      : missingTaskTypes.length > 0
        ? "repair_routes"
        : "start_creating",
  };
}

async function resolveProviderInput(input: CompleteQuickSetupRequest): Promise<{
  provider: LLMProvider;
  displayName?: string;
  existingKey?: string;
  existingBaseURL?: string;
}> {
  if (input.providerKind === "builtin") {
    if (!input.provider || !isBuiltInProvider(input.provider)) {
      throw new AppError("请选择一个可用的内置模型厂商。", 400);
    }
    const existing = await secretStore.getProvider(input.provider);
    return {
      provider: input.provider,
      existingKey: normalizeOptionalText(existing?.key) ?? getProviderEnvApiKey(input.provider),
      existingBaseURL: normalizeOptionalText(existing?.baseURL) ?? getProviderEnvBaseUrl(input.provider),
    };
  }
  const displayName = normalizeOptionalText(input.customProviderName);
  if (!displayName) {
    throw new AppError("请填写自定义厂商名称。", 400);
  }
  const provider = input.provider && !isBuiltInProvider(input.provider)
    ? input.provider
    : buildCustomProviderId(displayName);
  const existing = await secretStore.getProvider(provider);
  return {
    provider,
    displayName,
    existingKey: normalizeOptionalText(existing?.key),
    existingBaseURL: normalizeOptionalText(existing?.baseURL),
  };
}

export async function completeQuickSetup(
  input: CompleteQuickSetupRequest,
): Promise<CompleteQuickSetupResult> {
  const resolvedInput = await resolveProviderInput(input);
  const provider = resolvedInput.provider;
  const model = input.model.trim();
  const usesChatGPTPlan = provider === "openai" && input.authMode === "chatgpt_oauth";
  if (input.authMode === "chatgpt_oauth" && provider !== "openai") {
    throw new AppError("ChatGPT 网页授权只能用于 OpenAI。", 400);
  }
  if (usesChatGPTPlan && !(await chatGPTAuthService.status()).connected) {
    throw new AppError("请先完成 ChatGPT 网页授权。", 400);
  }
  const apiKey = usesChatGPTPlan ? undefined : normalizeOptionalText(input.apiKey) ?? resolvedInput.existingKey;
  const baseURL = normalizeOptionalText(input.baseURL)
    ?? resolvedInput.existingBaseURL
    ?? (isBuiltInProvider(provider) ? PROVIDERS[provider].baseURL : undefined);
  if (!model) {
    throw new AppError("请选择或填写一个文本模型。", 400);
  }
  if (!usesChatGPTPlan && isBuiltInProvider(provider) && providerRequiresApiKey(provider) && !apiKey) {
    throw new AppError("请填写 API Key。", 400);
  }
  if (!baseURL) {
    throw new AppError("请填写 API 地址。", 400);
  }

  const probe = await llmConnectivityService.testConnection({
    provider,
    apiKey,
    authMode: input.authMode,
    model,
    baseURL,
    probeMode: "both",
    structuredResponseFormat: usesChatGPTPlan ? "prompt_json" : undefined,
  });
  const plainReady = probe.plain?.ok === true;
  const structuredReady = probe.structured?.ok === true;
  if (!plainReady || !structuredReady) {
    const details = [
      !plainReady ? `普通文本：${probe.plain?.error ?? probe.error ?? "连接失败"}` : "",
      !structuredReady ? `结构化输出：${probe.structured?.error ?? probe.error ?? "连接失败"}` : "",
    ].filter(Boolean).join("；");
    throw new AppError(`模型检测未通过。${details}`, 400);
  }

  const record = await secretStore.upsertProvider(provider, {
    ...(resolvedInput.displayName ? { displayName: resolvedInput.displayName } : {}),
    key: apiKey ?? null,
    model,
    baseURL,
    authMode: usesChatGPTPlan ? "chatgpt_oauth" : "bearer",
    isActive: true,
    reasoningEnabled: true,
    reasoningEffort: usesChatGPTPlan ? normalizeReasoningEffort(input.reasoningEffort) : "high",
    hiddenModels: "[]",
    ...(usesChatGPTPlan
      ? { availableModels: serializeModelList((await chatGPTAuthService.status()).models.map((item) => item.slug)) }
      : {}),
  });
  setProviderSecretCache(provider, {
    displayName: record.displayName ?? undefined,
    key: record.key ?? undefined,
    model: record.model ?? undefined,
    baseURL: record.baseURL ?? undefined,
    authMode: record.authMode === "chatgpt_oauth" ? "chatgpt_oauth" : "bearer",
    reasoningEnabled: record.reasoningEnabled ?? true,
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
    concurrencyLimit: record.concurrencyLimit ?? 0,
    requestIntervalMs: record.requestIntervalMs ?? 0,
  });
  evictSharedLimiters(provider);

  await saveLLMSelectionSettings({ provider, model });
  await Promise.all(MODEL_ROUTE_TASK_TYPES.map((taskType) => upsertModelRouteConfig(taskType, {
    provider,
    model,
    temperature: ROUTE_TEMPERATURES[taskType],
    requestProtocol: probe.structured?.requestProtocol ?? probe.requestProtocol,
    structuredResponseFormat: probe.structured?.strategy,
  })));

  return {
    status: await getQuickSetupStatus(),
    provider,
    model,
    plainConnectionReady: plainReady,
    structuredConnectionReady: structuredReady,
  };
}
