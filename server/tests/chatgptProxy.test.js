const test = require("node:test");
const assert = require("node:assert/strict");

function loadNetworkModule() {
  try {
    return require("../dist/modules/setup/chatgpt-auth/infrastructure/OpenAINetwork.js");
  } catch {
    return {};
  }
}

test("ChatGPT network normalizes the enabled Windows HTTPS proxy", () => {
  const { normalizeWindowsProxy } = loadNetworkModule();
  assert.equal(typeof normalizeWindowsProxy, "function");
  assert.equal(normalizeWindowsProxy(true, "127.0.0.1:10808"), "http://127.0.0.1:10808");
  assert.equal(
    normalizeWindowsProxy(true, "http=127.0.0.1:8080;https=127.0.0.1:10808"),
    "http://127.0.0.1:10808",
  );
  assert.equal(normalizeWindowsProxy(false, "127.0.0.1:10808"), null);
});

test("ChatGPT network reuses a reachable loopback proxy even when the Windows proxy switch is off", async () => {
  const { resolveWindowsProxySettings } = loadNetworkModule();
  assert.equal(typeof resolveWindowsProxySettings, "function");

  const reachable = await resolveWindowsProxySettings(
    false,
    "127.0.0.1:10808",
    async () => true,
  );
  assert.equal(reachable, "http://127.0.0.1:10808");

  const stopped = await resolveWindowsProxySettings(
    false,
    "127.0.0.1:10808",
    async () => false,
  );
  assert.equal(stopped, null);

  const remote = await resolveWindowsProxySettings(
    false,
    "proxy.example.com:8080",
    async () => true,
  );
  assert.equal(remote, null);
});

test("ChatGPT network adds a dispatcher only when a proxy is available", async () => {
  const { createOpenAIFetch } = loadNetworkModule();
  assert.equal(typeof createOpenAIFetch, "function");

  const calls = [];
  const dispatcher = { proxy: true };
  const proxiedFetch = createOpenAIFetch({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response("ok");
    },
    resolveProxyUrl: async () => "http://127.0.0.1:10808",
    createDispatcher: () => dispatcher,
  });

  await proxiedFetch("https://auth.openai.com/token", { method: "POST" });
  assert.equal(calls[0].init.dispatcher, dispatcher);

  calls.length = 0;
  const directFetch = createOpenAIFetch({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response("ok");
    },
    resolveProxyUrl: async () => null,
    createDispatcher: () => dispatcher,
  });
  await directFetch("https://api.openai.com/v1/models");
  assert.equal(calls[0].init?.dispatcher, undefined);
});
