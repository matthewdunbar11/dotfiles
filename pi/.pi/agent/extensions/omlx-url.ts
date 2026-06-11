import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const baseUrl =
    process.env.OMLMX_BASE_URL || "http://127.0.0.1:8989/v1";

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
      reasoning: true,
      input: ["text", "image"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 262144,
    }));
  } catch (err) {
    console.error("[omlx-url] Failed to fetch models:", err);
  }

  pi.registerProvider("omlx", {
    baseUrl,
    apiKey: "password",
    authHeader: true,
    api: "openai-completions",
    models,
  });
}
