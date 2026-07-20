/**
 * LM Studio Extension
 *
 * Registers the LM Studio local server as a model provider using its
 * OpenAI-compatible API.  Models are auto-discovered from the
 * `/v1/models` endpoint so every loaded model becomes immediately
 * available in pi.
 *
 * Configuration:
 *   Set LMSTUDIO_BASE_URL (env var) to override the default endpoint.
 *   Default: http://127.0.0.1:1234/v1
 *
 * Usage:
 *   1. Start LM Studio and load a model.
 *   2. Open the Developer → Server tab and note the port (default 1234).
 *   3. /reload  (or restart pi) — the "lmstudio" provider appears in /model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const baseUrl =
    process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1";

  let models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }> = [];

  try {
    const response = await fetch(`${baseUrl}/models`);
    const payload = (await response.json()) as {
      data: Array<{ id: string }>;
    };

    models = payload.data.map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: false,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 262144,
    }));
  } catch {
    // Silently fail — no local server available
  }

  pi.registerProvider("lmstudio", {
    baseUrl,
    apiKey: "lm-studio",
    authHeader: true,
    api: "openai-completions",
    models,
  });
}
