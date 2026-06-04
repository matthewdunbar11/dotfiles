import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const baseUrl =
    process.env.OMLMX_BASE_URL || "http://127.0.0.1:8989/v1";

  pi.registerProvider("omlx", {
    baseUrl,
    apiKey: "password",
    authHeader: true,
    api: "openai-completions",
    models: [
      {
        id: "gemma-4-31B-it-MLX-8bit",
        name: "Gemma 4 31B",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
      {
        id: "Qwen3.6-27B-MLX-8bit",
        name: "Qwen3.6-27B",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
      {
        id: "Qwen3.6-35B-A3B-bf16",
        name: "Qwen3.6-35B bf16",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
      {
        id: "Qwen3.6-35B-A3B-8bit",
        name: "Qwen3.6-35B",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
      {
        id: "DeepSeek-V4-Flash-2bit-DQ",
        name: "DeepSeek V4 Flash 2bit",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  });
}
