import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  CompleteQuickSetupRequest,
  CompleteQuickSetupResult,
  ChatGPTAuthStatus,
  FirstNovelOnboardingProjection,
  QuickSetupStatus,
} from "@ai-novel/shared/types/onboarding";
import { apiClient } from "./client";

export async function getQuickSetupStatus() {
  const { data } = await apiClient.get<ApiResponse<QuickSetupStatus>>("/settings/quick-setup/status");
  return data;
}

export async function completeQuickSetup(payload: CompleteQuickSetupRequest) {
  const { data } = await apiClient.post<ApiResponse<CompleteQuickSetupResult>>(
    "/settings/quick-setup/complete",
    payload,
  );
  return data;
}

export async function startChatGPTAuthorization() {
  const { data } = await apiClient.post<ApiResponse<{ authorizationUrl: string }>>(
    "/settings/chatgpt/start",
  );
  return data;
}

export async function getChatGPTAuthStatus() {
  const { data } = await apiClient.get<ApiResponse<ChatGPTAuthStatus>>("/settings/chatgpt/status");
  return data;
}

export async function disconnectChatGPTAuthorization() {
  const { data } = await apiClient.delete<ApiResponse<null>>("/settings/chatgpt/session");
  return data;
}

export async function getFirstNovelOnboarding() {
  const { data } = await apiClient.get<ApiResponse<FirstNovelOnboardingProjection>>("/onboarding/first-novel");
  return data;
}
