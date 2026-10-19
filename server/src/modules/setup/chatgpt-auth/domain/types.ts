export interface ChatGPTPlanModel {
  slug: string;
  displayName: string;
}

export interface ChatGPTCredentialProfile {
  version: 1;
  hostId: string;
  clientId: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  models: ChatGPTPlanModel[];
}

export interface ChatGPTAuthStatus {
  connected: boolean;
  pending: boolean;
  email: string | null;
  displayName: string | null;
  models: ChatGPTPlanModel[];
  error: string | null;
}
