# ChatGPT 网页授权模块

本模块负责 OpenAI 面向开源本地应用的 Sign in with ChatGPT 流程，以及授权后的 Responses API 适配。它属于 `setup`，因为授权建立的是模型连接能力；小说生产模块只通过统一 LLM factory 使用它，不得直接读取 OAuth 凭据。

## 边界

- `application/ChatGPTAuthService.ts` 管理 PKCE/OIDC 事务、ID token 校验、scope 检查、模型目录和串行令牌刷新。
- `infrastructure/EncryptedChatGPTCredentialStore.ts` 在用户应用数据目录保存稳定主机 ID，并用本机随机密钥和 AES-256-GCM 加密账户凭据。令牌不得进入数据库、浏览器存储、日志或 API 响应。
- `application/ChatGPTPlanLLM.ts` 把 LangChain 消息适配到公共 `/v1/responses`。它固定发送 `store:false`、`stream:true`，并且只有收到 `response.completed` 才把调用视为成功。
- `http/chatGPTAuthRoutes.ts` 暴露开始授权、脱敏状态、断开授权和 loopback 回调。回调 URI 必须使用 `127.0.0.1`，不能替换为 `localhost`。

## 调用规则

数据库中的 OpenAI 厂商记录只保存 `authMode=chatgpt_oauth`、模型和官方 Base URL。LLM factory 在每次请求前从授权服务取得有效 access token；结构化请求使用 `prompt_json`，不向此预览通道发送 temperature、max output 或持久会话字段。

若用户断开授权，加密凭据会在本机删除，稳定主机 ID 继续保留，供同一主机后续注册或重新授权使用。
