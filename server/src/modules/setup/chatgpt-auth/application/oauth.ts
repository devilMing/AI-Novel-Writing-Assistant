import crypto from "node:crypto";

export const CHATGPT_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;

export interface ChatGPTAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  requestedClientId: string;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function buildChatGPTAuthorizationRequest(input: {
  hostId: string;
  redirectUri: string;
  agentName: string;
  clientId?: string;
  idTokenHint?: string;
  loginHint?: string;
  randomBytes?: (size: number) => Buffer;
}): ChatGPTAuthorizationRequest {
  const randomBytes = input.randomBytes ?? crypto.randomBytes;
  const state = base64Url(randomBytes(32));
  const nonce = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const requestedClientId = input.clientId ?? "dynamic_agent_client";
  const url = new URL(CHATGPT_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", requestedClientId);
  if (!input.clientId) {
    url.searchParams.set("agent_name_hint", input.agentName);
  }
  url.searchParams.set("ext_agent_host_id", input.hostId);
  if (input.idTokenHint) url.searchParams.set("id_token_hint", input.idTokenHint);
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CHATGPT_PLAN_SCOPES.join(" "));
  url.searchParams.set("resource", CHATGPT_RESOURCE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set(
    "code_challenge",
    crypto.createHash("sha256").update(codeVerifier).digest("base64url"),
  );
  return {
    authorizationUrl: url.toString(),
    state,
    nonce,
    codeVerifier,
    redirectUri: input.redirectUri,
    requestedClientId,
  };
}

export function hasChatGPTPlanScope(scopes: readonly string[]): boolean {
  return scopes.includes("chatgpt.tokens.use.direct") && scopes.includes("resource.invoke");
}
