import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("OpenAI quick setup exposes ChatGPT web authorization without browser token storage", () => {
  const dialog = fs.readFileSync(path.join(root, "src/components/onboarding/QuickSetupDialog.tsx"), "utf8");
  const api = fs.readFileSync(path.join(root, "src/api/onboarding.ts"), "utf8");
  const selector = fs.readFileSync(path.join(root, "src/components/common/LLMSelector.tsx"), "utf8");

  assert.match(dialog, /Continue with ChatGPT/);
  assert.match(dialog, /使用 ChatGPT 套餐/);
  assert.match(dialog, /推理强度/);
  assert.match(dialog, /reasoningEffort/);
  assert.match(api, /startChatGPTAuthorization/);
  assert.match(api, /getChatGPTAuthStatus/);
  assert.doesNotMatch(dialog, /localStorage.*accessToken|sessionStorage.*accessToken/);
  assert.match(selector, /shouldWaitForProviderRefresh/);
  assert.match(selector, /apiKeySettingsQuery\.isFetching/);
});
