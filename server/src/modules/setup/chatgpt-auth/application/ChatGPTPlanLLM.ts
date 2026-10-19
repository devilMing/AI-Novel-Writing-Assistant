import {
  AIMessage,
  AIMessageChunk,
  SystemMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { ReasoningEffort } from "@ai-novel/shared/types/llm";

interface ChatGPTPlanLLMOptions {
  model: string;
  reasoningEffort?: ReasoningEffort;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function textContent(content: MessageContent | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return part.text;
    }
    return "";
  }).join("\n");
}

function convertMessages(messages: BaseMessage[]): {
  instructions?: string;
  input: Array<{ role: "user" | "assistant" | "developer"; content: string }>;
} {
  const instructions: string[] = [];
  const input: Array<{ role: "user" | "assistant" | "developer"; content: string }> = [];
  for (const message of messages) {
    const content = textContent(message.content).trim();
    if (!content) continue;
    if (message instanceof SystemMessage || message._getType?.() === "system") {
      instructions.push(content);
      continue;
    }
    input.push({
      role: message._getType?.() === "ai" ? "assistant" : "user",
      content,
    });
  }
  return {
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    input,
  };
}

function eventError(event: Record<string, unknown>): Error | null {
  if (event.type === "response.failed") {
    const response = event.response as { error?: { code?: string; message?: string } } | undefined;
    return new Error(response?.error?.message ?? response?.error?.code ?? "ChatGPT 请求失败。");
  }
  if (event.type === "response.incomplete") {
    const response = event.response as { incomplete_details?: { reason?: string } } | undefined;
    return new Error(`ChatGPT 响应未完成：${response?.incomplete_details?.reason ?? "incomplete"}`);
  }
  if (event.type === "error") {
    const error = event.error as { message?: string } | undefined;
    return new Error(error?.message ?? "ChatGPT 流式响应发生错误。");
  }
  return null;
}

export function createChatGPTPlanLLM(options: ChatGPTPlanLLMOptions): ChatOpenAI {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function openStream(messages: BaseMessage[], callOptions?: { signal?: AbortSignal }) {
    const token = await options.getAccessToken();
    const controller = new AbortController();
    const onAbort = () => controller.abort(callOptions?.signal?.reason);
    callOptions?.signal?.addEventListener("abort", onAbort, { once: true });
    if (callOptions?.signal?.aborted) onAbort();
    const timer = options.timeoutMs
      ? setTimeout(() => controller.abort(new Error("ChatGPT 请求超时。")), options.timeoutMs)
      : null;
    try {
      const converted = convertMessages(messages);
      if (converted.input.length === 0) throw new Error("ChatGPT 请求至少需要一条用户消息。");
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: options.model,
          input: converted.input,
          ...(converted.instructions ? { instructions: converted.instructions } : {}),
          ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
          store: false,
          stream: true,
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`ChatGPT 请求失败（${response.status}）：${detail || response.statusText}`);
      }
      if (!response.body) throw new Error("ChatGPT 流式响应为空。");
      return { response, controller, timer, onAbort };
    } catch (error) {
      if (timer) clearTimeout(timer);
      callOptions?.signal?.removeEventListener("abort", onAbort);
      throw error;
    }
  }

  const llm = {
    async stream(messages: BaseMessage[], callOptions?: { signal?: AbortSignal }) {
      const opened = await openStream(messages, callOptions);
      const reader = opened.response.body!.getReader();
      return (async function* () {
        const decoder = new TextDecoder();
        let buffer = "";
        let completed = false;
        const parseLine = (line: string): Record<string, unknown> | null => {
          if (!line.startsWith("data:")) return null;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") return null;
          try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
        };
        const handleEvent = (event: Record<string, unknown>): AIMessageChunk | null => {
          const error = eventError(event);
          if (error) throw error;
          if (event.type === "response.completed") {
            completed = true;
            const response = event.response as { usage?: Record<string, unknown> } | undefined;
            return new AIMessageChunk({
              content: "",
              response_metadata: response?.usage ? { usage: response.usage } : {},
            });
          }
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            return new AIMessageChunk({ content: event.delta });
          }
          return null;
        };
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/u);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const event = parseLine(line.trim());
              if (!event) continue;
              const chunk = handleEvent(event);
              if (chunk) yield chunk;
            }
          }
          buffer += decoder.decode();
          for (const line of buffer.split(/\r?\n/u)) {
            const event = parseLine(line.trim());
            if (!event) continue;
            const chunk = handleEvent(event);
            if (chunk) yield chunk;
          }
          if (!completed) throw new Error("ChatGPT 流式响应未完成：缺少 response.completed。 ");
        } finally {
          if (opened.timer) clearTimeout(opened.timer);
          callOptions?.signal?.removeEventListener("abort", opened.onAbort);
          reader.releaseLock();
        }
      })();
    },
    async invoke(messages: BaseMessage[], callOptions?: { signal?: AbortSignal }) {
      let content = "";
      let responseMetadata: Record<string, unknown> = {};
      for await (const chunk of await this.stream(messages, callOptions)) {
        content += textContent(chunk.content);
        responseMetadata = { ...responseMetadata, ...chunk.response_metadata };
      }
      return new AIMessage({ content, response_metadata: responseMetadata });
    },
    async batch(messages: BaseMessage[][], callOptions?: { signal?: AbortSignal }) {
      return Promise.all(messages.map((entry) => this.invoke(entry, callOptions)));
    },
  };
  return llm as unknown as ChatOpenAI;
}
