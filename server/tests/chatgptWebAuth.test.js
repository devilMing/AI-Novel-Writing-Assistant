const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  CHATGPT_PLAN_SCOPES,
  buildChatGPTAuthorizationRequest,
} = require("../dist/modules/setup/chatgpt-auth/application/oauth.js");
const {
  EncryptedChatGPTCredentialStore,
} = require("../dist/modules/setup/chatgpt-auth/infrastructure/EncryptedChatGPTCredentialStore.js");
const {
  createChatGPTPlanLLM,
} = require("../dist/modules/setup/chatgpt-auth/application/ChatGPTPlanLLM.js");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

function sseResponse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("ChatGPT authorization uses dynamic registration, PKCE, loopback callback and plan scopes", () => {
  const request = buildChatGPTAuthorizationRequest({
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    redirectUri: "http://127.0.0.1:3000/api/settings/chatgpt/callback",
    agentName: "AI Novel Writing Assistant",
    randomBytes: (size) => Buffer.alloc(size, 7),
  });

  const url = new URL(request.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("redirect_uri"), request.redirectUri);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), CHATGPT_PLAN_SCOPES.join(" "));
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(url.searchParams.get("nonce"), request.nonce);
  assert.equal(
    url.searchParams.get("code_challenge"),
    crypto.createHash("sha256").update(request.codeVerifier).digest("base64url"),
  );
});

test("ChatGPT credentials are encrypted at rest and can be read back", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-novel-chatgpt-auth-"));
  const store = new EncryptedChatGPTCredentialStore({ directory });
  const profile = {
    version: 1,
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    clientId: "oaiapp_example",
    subject: "account-1",
    email: "writer@example.com",
    displayName: "Writer",
    scopes: CHATGPT_PLAN_SCOPES,
    accessToken: "access-secret-value",
    refreshToken: "refresh-secret-value",
    idToken: "id-secret-value",
    expiresAt: Date.now() + 3_600_000,
    models: [{ slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }],
  };

  try {
    await store.save(profile);
    const raw = await fs.readFile(path.join(directory, "chatgpt-credentials.enc.json"), "utf8");
    assert.equal(raw.includes(profile.accessToken), false);
    assert.equal(raw.includes(profile.refreshToken), false);
    assert.deepEqual(await store.load(), profile);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ChatGPT plan model always uses streaming Responses API with store false", async () => {
  let captured;
  const llm = createChatGPTPlanLLM({
    model: "gpt-6.1-sol",
    reasoningEffort: "max",
    getAccessToken: async () => "oauth-access-token",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return sseResponse([
        { type: "response.output_text.delta", delta: "你好" },
        { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
      ]);
    },
  });

  const chunks = [];
  for await (const chunk of await llm.stream([
    new SystemMessage("你是一位小说编辑。"),
    new HumanMessage("写一句开场。"),
  ])) {
    chunks.push(chunk.content);
  }

  assert.equal(chunks.join(""), "你好");
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.init.headers.Authorization, "Bearer oauth-access-token");
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.instructions, "你是一位小说编辑。");
  assert.equal(captured.body.temperature, undefined);
  assert.equal(captured.body.max_output_tokens, undefined);
  assert.deepEqual(captured.body.reasoning, { effort: "max" });
  assert.ok(Array.isArray(captured.body.input));
});

test("ChatGPT plan stream is rejected when response.completed is missing", async () => {
  const llm = createChatGPTPlanLLM({
    model: "gpt-6.1-sol",
    getAccessToken: async () => "oauth-access-token",
    fetchImpl: async () => sseResponse([
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    ]),
  });

  await assert.rejects(async () => {
    for await (const _chunk of await llm.stream([new HumanMessage("test")])) {
      // Drain the stream.
    }
  }, /未完成|incomplete/i);
});
