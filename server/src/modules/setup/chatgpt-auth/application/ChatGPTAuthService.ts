import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "../../../../middleware/errorHandler";
import { chatGPTCredentialStore } from "../infrastructure/EncryptedChatGPTCredentialStore";
import { openAIFetch } from "../infrastructure/OpenAINetwork";
import type {
  ChatGPTAuthStatus,
  ChatGPTCredentialProfile,
  ChatGPTPlanModel,
} from "../domain/types";
import {
  buildChatGPTAuthorizationRequest,
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_ENDPOINT,
  hasChatGPTPlanScope,
} from "./oauth";

const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 60 * 1000;

interface PendingAttempt {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  requestedClientId: string;
  existingSubject: string | null;
  createdAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

function splitScopes(value: string | undefined): string[] {
  return Array.from(new Set((value ?? "").split(/\s+/u).map((item) => item.trim()).filter(Boolean)));
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await openAIFetch(CHATGPT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AppError(`ChatGPT 授权令牌请求失败（${response.status}）。`, 502, text.slice(0, 500));
  }
  return JSON.parse(text) as TokenResponse;
}

async function validateIdToken(idToken: string, clientId: string, nonce?: string): Promise<JWTPayload> {
  const jwksResponse = await openAIFetch(OPENAI_JWKS_URL, { headers: { Accept: "application/json" } });
  if (!jwksResponse.ok) {
    throw new AppError(`读取 OpenAI 身份签名密钥失败（${jwksResponse.status}）。`, 502);
  }
  const jwks = createLocalJWKSet(await jwksResponse.json() as Parameters<typeof createLocalJWKSet>[0]);
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: OPENAI_ISSUER,
    audience: clientId,
    ...(nonce ? { nonce } : {}),
  });
  if (!payload.sub) throw new AppError("ChatGPT 身份令牌缺少账户标识。", 502);
  return payload;
}

function parseModels(payload: unknown): ChatGPTPlanModel[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) {
    return [];
  }
  return (payload as { models: unknown[] }).models.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { slug?: unknown; display_name?: unknown; visibility?: unknown };
    if (candidate.visibility !== "list" || typeof candidate.slug !== "string") return [];
    return [{
      slug: candidate.slug,
      displayName: typeof candidate.display_name === "string" ? candidate.display_name : candidate.slug,
    }];
  });
}

export class ChatGPTAuthService {
  private readonly pending = new Map<string, PendingAttempt>();
  private lastError: string | null = null;
  private refreshPromise: Promise<ChatGPTCredentialProfile> | null = null;

  async start(input: { redirectUri: string }): Promise<{ authorizationUrl: string }> {
    const [hostId, existing] = await Promise.all([
      chatGPTCredentialStore.loadOrCreateHostId(),
      chatGPTCredentialStore.load(),
    ]);
    const request = buildChatGPTAuthorizationRequest({
      hostId,
      redirectUri: input.redirectUri,
      agentName: "AI Novel Writing Assistant",
      ...(existing ? {
        clientId: existing.clientId,
        idTokenHint: existing.idToken,
        ...(existing.email ? { loginHint: existing.email } : {}),
      } : {}),
    });
    this.expireAttempts();
    this.pending.set(request.state, {
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      redirectUri: request.redirectUri,
      requestedClientId: request.requestedClientId,
      existingSubject: existing?.subject ?? null,
      createdAt: Date.now(),
    });
    this.lastError = null;
    return { authorizationUrl: request.authorizationUrl };
  }

  private expireAttempts(): void {
    const cutoff = Date.now() - ATTEMPT_TTL_MS;
    for (const [state, attempt] of this.pending) {
      if (attempt.createdAt < cutoff) this.pending.delete(state);
    }
  }

  async completeCallback(input: {
    state?: string;
    code?: string;
    clientId?: string;
    error?: string;
  }): Promise<ChatGPTCredentialProfile> {
    this.expireAttempts();
    const attempt = input.state ? this.pending.get(input.state) : undefined;
    if (!attempt) throw new AppError("ChatGPT 授权状态无效或已过期，请重新发起授权。", 400);
    this.pending.delete(attempt.state);
    if (input.error) {
      this.lastError = input.error === "access_denied" ? "你取消了 ChatGPT 授权。" : `ChatGPT 授权失败：${input.error}`;
      throw new AppError(this.lastError, 400);
    }
    if (!input.code) throw new AppError("ChatGPT 授权回调缺少 code。", 400);

    const newRegistration = attempt.requestedClientId === "dynamic_agent_client";
    const clientId = newRegistration ? input.clientId : attempt.requestedClientId;
    if (!clientId || clientId === "dynamic_agent_client") {
      throw new AppError("ChatGPT 首次授权没有返回有效的客户端 ID。", 400);
    }
    if (!newRegistration && input.clientId && input.clientId !== clientId) {
      throw new AppError("ChatGPT 授权返回了不匹配的客户端 ID。", 400);
    }
    const token = await postToken(new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: input.code,
      code_verifier: attempt.codeVerifier,
      redirect_uri: attempt.redirectUri,
      resource: CHATGPT_RESOURCE,
    }));
    if (!token.access_token || !token.refresh_token || !token.id_token) {
      throw new AppError("ChatGPT 授权返回的凭据不完整。", 502);
    }
    const scopes = splitScopes(token.scope);
    if (!hasChatGPTPlanScope(scopes)) {
      throw new AppError("此授权未包含使用 ChatGPT 套餐的权限，请重新授权并允许套餐用量。", 403);
    }
    const identity = await validateIdToken(token.id_token, clientId, attempt.nonce);
    if (attempt.existingSubject && attempt.existingSubject !== identity.sub) {
      throw new AppError("本次授权账户与已保存账户不一致，请先断开后再切换账户。", 409);
    }
    const profile: ChatGPTCredentialProfile = {
      version: 1,
      hostId: await chatGPTCredentialStore.loadOrCreateHostId(),
      clientId,
      subject: identity.sub!,
      email: typeof identity.email === "string" ? identity.email : null,
      displayName: typeof identity.name === "string" ? identity.name : null,
      scopes,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken: token.id_token,
      expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
      models: [],
    };
    profile.models = await this.fetchModels(profile.accessToken);
    if (profile.models.length === 0) {
      throw new AppError("ChatGPT 套餐没有返回可用模型。", 400);
    }
    await chatGPTCredentialStore.save(profile);
    this.lastError = null;
    return profile;
  }

  private async fetchModels(accessToken: string): Promise<ChatGPTPlanModel[]> {
    const response = await openAIFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) throw new AppError(`读取 ChatGPT 可用模型失败（${response.status}）。`, 502, text.slice(0, 500));
    return parseModels(JSON.parse(text));
  }

  async status(): Promise<ChatGPTAuthStatus> {
    this.expireAttempts();
    const profile = await chatGPTCredentialStore.load();
    return {
      connected: Boolean(profile && hasChatGPTPlanScope(profile.scopes)),
      pending: this.pending.size > 0,
      email: profile?.email ?? null,
      displayName: profile?.displayName ?? null,
      models: profile?.models ?? [],
      error: this.lastError,
    };
  }

  async getAccessToken(): Promise<string> {
    const profile = await chatGPTCredentialStore.load();
    if (!profile) throw new AppError("尚未通过 ChatGPT 网页授权。", 401);
    if (profile.expiresAt > Date.now() + REFRESH_EARLY_MS) return profile.accessToken;
    this.refreshPromise ??= this.refresh(profile).finally(() => { this.refreshPromise = null; });
    return (await this.refreshPromise).accessToken;
  }

  private async refresh(profile: ChatGPTCredentialProfile): Promise<ChatGPTCredentialProfile> {
    const token = await postToken(new URLSearchParams({
      grant_type: "refresh_token",
      client_id: profile.clientId,
      refresh_token: profile.refreshToken,
      resource: CHATGPT_RESOURCE,
    }));
    if (!token.access_token) throw new AppError("ChatGPT 会话刷新失败，请重新授权。", 401);
    const scopes = token.scope ? splitScopes(token.scope) : profile.scopes;
    if (!hasChatGPTPlanScope(scopes)) throw new AppError("ChatGPT 套餐使用权限已失效，请重新授权。", 403);
    const next = {
      ...profile,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? profile.refreshToken,
      idToken: token.id_token ?? profile.idToken,
      scopes,
      expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
    };
    if (token.id_token) {
      const identity = await validateIdToken(token.id_token, profile.clientId);
      if (identity.sub !== profile.subject) throw new AppError("ChatGPT 刷新后的账户身份不匹配。", 401);
    }
    await chatGPTCredentialStore.save(next);
    return next;
  }

  async disconnect(): Promise<void> {
    this.pending.clear();
    this.lastError = null;
    await chatGPTCredentialStore.clear();
  }
}

export const chatGPTAuthService = new ChatGPTAuthService();
