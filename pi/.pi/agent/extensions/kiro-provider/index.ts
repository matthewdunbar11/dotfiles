/**
 * Amazon Kiro Provider Extension for Pi
 *
 * Adds Kiro as an LLM provider using the kiro-ai-provider package.
 * Supports AWS Builder ID, IAM Identity Center, and API key auth.
 *
 * Authentication:
 *   - If already logged in via Kiro IDE or kiro-cli, the cached token
 *     at ~/.aws/sso/cache/kiro-auth-token.json is picked up automatically.
 *   - Use /login kiro for interactive OAuth (Builder ID or IAM Identity Center).
 *   - Set KIRO_API_KEY env var for API key auth (Pro, Pro+, Power subscriptions).
 *
 * Usage:
 *   pi -e ./pi/.pi/agent/extensions/kiro-provider
 *   # Then use /model to select kiro/<model>
 *
 * Reference:
 *   https://github.com/anomalyco/opencode/pull/20491
 *   https://github.com/NachoFLizaur/kiro-ai-provider
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  calculateCost,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type KiroStreamEvent,
  authenticate,
  getToken,
  getApiRegion,
  getQuota,
  hasToken,
  listModels,
} from "kiro-ai-provider";

// =============================================================================
// Constants
// =============================================================================

const BUILDER_ID_URL = "https://view.awsapps.com/start";

// =============================================================================
// OAuth Implementation
// =============================================================================

async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  // Ask user to select authentication type
  const authType = await callbacks.onPrompt({
    message: "Select Kiro authentication type:\n1. AWS Builder ID (free)\n2. IAM Identity Center (enterprise)",
    placeholder: "1 or 2",
  });

  const isBuilderId = authType.trim() === "1" || authType.toLowerCase().includes("builder");

  let startUrl: string;
  let region: string;

  if (isBuilderId) {
    startUrl = BUILDER_ID_URL;
    region = "us-east-1";
  } else {
    // IAM Identity Center - need start URL and region
    const inputStartUrl = await callbacks.onPrompt({
      message: "Enter your SSO start URL:",
      placeholder: "https://d-xxxxxxxxxx.awsapps.com/start",
    });
    startUrl = inputStartUrl.trim() || process.env.AWS_SSO_START_URL || "";

    if (!startUrl) {
      throw new Error("SSO start URL is required for IAM Identity Center");
    }

    const inputRegion = await callbacks.onPrompt({
      message: "Enter your AWS SSO region:",
      placeholder: "us-east-1",
    });
    region = inputRegion.trim() || process.env.AWS_SSO_REGION || "us-east-1";
  }

  const { promise: pending, resolve } = Promise.withResolvers<{
    url: string;
    code: string;
  }>();

  const auth = authenticate({
    startUrl,
    region,
    onVerification: (url, code) => resolve({ url, code }),
  });

  const verification = await pending;

  // Open the verification URL in the browser and show the user code
  callbacks.onAuth({
    url: verification.url,
    instructions: `Enter code: ${verification.code}`,
  });

  const result = await auth;

  return {
    refresh: result.refreshToken,
    access: result.accessToken,
    expires: Date.now() + 3600000,
  };
}

async function refreshKiroToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  // The kiro-ai-provider handles token refresh internally via the
  // cached token file. We just need to get a fresh token.
  const token = await getToken();
  if (token) {
    return {
      refresh: credentials.refresh,
      access: token,
      expires: Date.now() + 3600000,
    };
  }
  // If we can't refresh, return existing credentials and let it fail
  // naturally on the next request.
  return credentials;
}

// =============================================================================
// Kiro API Interaction
// =============================================================================

// Re-use the event stream decoder from kiro-ai-provider's internals.
// We import the public decodeEventStream indirectly through the package's
// compiled output by importing the stream event types and doing raw API calls.

/**
 * Build the Kiro conversationState payload from Pi's context.
 */
function buildConversationState(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): {
  conversationState: any;
  conversationId: string;
} {
  const conversationId = crypto.randomUUID();

  // Build history from context messages
  const history: any[] = [];
  const systemParts: string[] = [];

  if (context.systemPrompt) {
    systemParts.push(context.systemPrompt);
  }

  // Process messages into Kiro format
  for (let i = 0; i < context.messages.length; i++) {
    const msg = context.messages[i];

    if (msg.role === "user") {
      const content = extractTextContent(msg);
      if (content.trim()) {
        history.push({
          userInputMessage: {
            content,
            modelId: model.id,
            origin: "AI_EDITOR",
          },
        });
      }
    } else if (msg.role === "assistant") {
      const textContent = msg.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const toolUses = msg.content
        .filter((b): b is ToolCall => b.type === "toolCall")
        .map((tc) => ({
          name: tc.name,
          input: tc.arguments,
          toolUseId: tc.id,
        }));

      const assistantMsg: any = {
        content: textContent || "(empty)",
      };
      if (toolUses.length > 0) {
        assistantMsg.toolUses = toolUses;
      }

      history.push({ assistantResponseMessage: assistantMsg });
    } else if (msg.role === "toolResult") {
      // Collect consecutive tool results
      const toolResults: any[] = [];
      let j = i;
      while (
        j < context.messages.length &&
        context.messages[j].role === "toolResult"
      ) {
        const tr = context.messages[j] as ToolResultMessage;
        toolResults.push({
          toolUseId: tr.toolCallId,
          content: [
            {
              text: tr.content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("\n") || "(no output)",
            },
          ],
          status: tr.isError ? "error" : "success",
        });
        j++;
      }
      i = j - 1;

      history.push({
        userInputMessage: {
          content: " ",
          modelId: model.id,
          origin: "AI_EDITOR",
          userInputMessageContext: {
            toolResults,
          },
        },
      });
    }
  }

  // Separate last user message as currentMessage
  let currentContent = " ";
  const historyForRequest = [...history];

  // Find and remove the last user message to use as currentMessage
  for (let i = historyForRequest.length - 1; i >= 0; i--) {
    if ("userInputMessage" in historyForRequest[i]) {
      const lastUserMsg = historyForRequest.splice(i, 1)[0];
      currentContent = lastUserMsg.userInputMessage.content;
      // If this message had tool results, preserve them
      if (lastUserMsg.userInputMessage.userInputMessageContext?.toolResults) {
        const ctx: any = {};
        ctx.toolResults =
          lastUserMsg.userInputMessage.userInputMessageContext.toolResults;
        if (context.tools) {
          ctx.tools = convertToolsToKiro(context.tools);
        }
        // Prepend system prompt to first message if history is empty
        const content =
          historyForRequest.length === 0 && systemParts.length > 0
            ? systemParts.join("\n") + "\n" + currentContent
            : currentContent;
        return {
          conversationId,
          conversationState: {
            conversationId,
            currentMessage: {
              userInputMessage: {
                content,
                modelId: model.id,
                origin: "AI_EDITOR",
                userInputMessageContext: ctx,
              },
            },
            history: historyForRequest,
            chatTriggerType: "MANUAL",
          },
        };
      }
      break;
    }
  }

  // Build tool specs
  const userInputMessageContext: any = {};
  if (context.tools) {
    userInputMessageContext.tools = convertToolsToKiro(context.tools);
  }

  // Prepend system prompt to first history message or current message
  const content =
    historyForRequest.length === 0 && systemParts.length > 0
      ? systemParts.join("\n") + "\n" + currentContent
      : currentContent;

  // If history exists, prepend system prompt to the first history message
  if (historyForRequest.length > 0 && systemParts.length > 0) {
    const first = historyForRequest[0];
    if ("userInputMessage" in first) {
      first.userInputMessage.content =
        systemParts.join("\n") + "\n" + first.userInputMessage.content;
    }
  }

  return {
    conversationId,
    conversationState: {
      conversationId,
      currentMessage: {
        userInputMessage: {
          content,
          modelId: model.id,
          origin: "AI_EDITOR",
          userInputMessageContext: Object.keys(userInputMessageContext).length
            ? userInputMessageContext
            : undefined,
        },
      },
      history: historyForRequest,
      chatTriggerType: "MANUAL",
    },
  };
}

function extractTextContent(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  return (msg.content as any[])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

function convertToolsToKiro(tools: Tool[]): any[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: {
          type: "object",
          properties: (tool.parameters as any).properties || {},
          required: (tool.parameters as any).required || [],
        },
      },
    },
  }));
}

// =============================================================================
// AWS Event Stream Decoder
// =============================================================================

// The Kiro API uses AWS binary event stream protocol.
// We import the codec from @smithy/eventstream-codec via kiro-ai-provider's
// bundled dependencies, but since that's internal, we implement a minimal
// decoder here using the same approach.

// Import the codec from the kiro-ai-provider's transitive dependency.
// Use dynamic import to work with both ESM and CJS loaders.
let _codecModule: any;
async function loadCodec() {
  if (!_codecModule) {
    _codecModule = await import("@smithy/eventstream-codec");
  }
  return _codecModule.EventStreamCodec;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function createCodec() {
  // Codec is loaded lazily; callers must await loadCodec() first
  if (!_codecModule) {
    throw new Error(
      "@smithy/eventstream-codec not loaded. Internal error.",
    );
  }
  return new _codecModule.EventStreamCodec(
    (input: string | Uint8Array) => {
      if (typeof input === "string") return input;
      return textDecoder.decode(input);
    },
    (input: string) => textEncoder.encode(input),
  );
}

function mergeBuffers(buffers: Uint8Array[], total: number): Uint8Array {
  if (buffers.length === 1) return buffers[0];
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buf of buffers) {
    merged.set(buf, offset);
    offset += buf.length;
  }
  return merged;
}

const MAX_FRAME = 16 * 1024 * 1024;

async function* chunkedFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  const buffer: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer.push(value);
      total += value.length;

      while (total >= 4) {
        const merged = mergeBuffers(buffer, total);
        const view = new DataView(merged.buffer, merged.byteOffset);
        const length = view.getUint32(0, false);
        if (length > MAX_FRAME) {
          throw new Error(`Event stream frame too large: ${length}`);
        }
        if (total < length) break;

        yield merged.slice(0, length);
        const remainder = merged.slice(length);
        buffer.length = 0;
        if (remainder.length > 0) buffer.push(remainder);
        total = remainder.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function getHeader(
  headers: Record<string, any>,
  name: string,
): string | undefined {
  const entry = headers[name];
  if (!entry) return undefined;
  if (entry.type === "string") return entry.value;
  if (entry.type === "binary") return textDecoder.decode(entry.value);
  return String(entry.value);
}

function safeParse(s: string): any | undefined {
  try {
    const result = JSON.parse(s);
    if (typeof result === "object" && result !== null) return result;
    return undefined;
  } catch {
    return undefined;
  }
}

function interpretEvent(message: any): KiroStreamEvent | undefined {
  const kind = getHeader(message.headers, ":message-type");
  const event = getHeader(message.headers, ":event-type");

  if (kind === "error" || kind === "exception") {
    const body = textDecoder.decode(message.body);
    return { type: "error", payload: { message: body } };
  }

  if (kind !== "event") return undefined;
  if (message.body.length === 0) return undefined;

  const body = textDecoder.decode(message.body);
  const payload = safeParse(body);
  if (!payload) return undefined;

  switch (event) {
    case "assistantResponseEvent": {
      if ("content" in payload) return { type: "content", payload };
      if ("name" in payload) return { type: "tool_start", payload };
      if ("stop" in payload) return { type: "tool_stop", payload };
      if ("usage" in payload) return { type: "usage", payload };
      if ("input" in payload) return { type: "tool_input", payload };
      return undefined;
    }
    case "toolUseEvent": {
      if ("stop" in payload) return { type: "tool_stop", payload };
      if ("input" in payload) return { type: "tool_input", payload };
      return { type: "tool_start", payload };
    }
    case "contextUsageEvent":
      return { type: "context_usage", payload };
    case "meteringEvent":
      return { type: "usage", payload };
    default:
      return undefined;
  }
}

async function* decodeEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<KiroStreamEvent> {
  await loadCodec();
  const codec = createCodec();
  for await (const frame of chunkedFrames(stream)) {
    const message = codec.decode(frame);
    const event = interpretEvent(message);
    if (event) yield event;
  }
}

// =============================================================================
// Kiro API Headers
// =============================================================================

function kiroHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-amz-json-1.0",
    ...(token.startsWith("ksk_") ? { tokentype: "API_KEY" } : {}),
    "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/${process.platform} lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-pi`,
    "x-amz-user-agent": "aws-sdk-js/1.0.27 Kiro-pi",
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
  };
}

// =============================================================================
// Thinking Tool Definition
// =============================================================================

const THINKING_TOOL = {
  toolSpecification: {
    name: "thinking",
    description:
      "Internal reasoning tool for working through complex problems. " +
      "Use for multi-step planning, analyzing constraints, debugging, " +
      "evaluating trade-offs, or synthesizing information before acting. " +
      "Do not use for simple lookups or straightforward tasks.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          thought: {
            type: "string",
            description: "Your step-by-step reasoning process",
          },
        },
        required: ["thought"],
      },
    },
  },
};

// =============================================================================
// Stream Implementation
// =============================================================================

function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // Get auth token - try options.apiKey first, then kiro-ai-provider
      const token = options?.apiKey || (await getToken());
      if (!token) {
        throw new Error(
          "No Kiro auth token. Use /login kiro, set KIRO_API_KEY, or log in via Kiro IDE.",
        );
      }

      // Build request
      const { conversationState } = buildConversationState(
        model,
        context,
        options,
      );

      // Inject thinking tool if the model supports reasoning
      if (model.reasoning) {
        const ctx =
          conversationState.currentMessage.userInputMessage
            .userInputMessageContext || {};
        const tools = ctx.tools || [];
        if (!tools.some((t: any) => t.toolSpecification.name === "thinking")) {
          ctx.tools = [...tools, THINKING_TOOL];
        }
        conversationState.currentMessage.userInputMessage.userInputMessageContext =
          ctx;
      }

      // Determine API region
      const region = await getApiRegion(token);
      const endpoint = `https://q.${region}.amazonaws.com/`;

      // Make the API request
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...kiroHeaders(token),
          "X-Amz-Target":
            "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
          "amz-sdk-invocation-id": crypto.randomUUID(),
          "amz-sdk-request": "attempt=1; max=1",
        },
        body: JSON.stringify({ conversationState }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Kiro API error ${response.status}: ${text}`);
      }

      if (!response.body) {
        throw new Error("Kiro API returned empty response body");
      }

      // Push start event
      stream.push({ type: "start", partial: output });

      // Track current state
      let currentTextIndex = -1;
      let currentToolIndex = -1;
      let toolPartialJson = "";

      // Decode the AWS Event Stream
      for await (const event of decodeEventStream(response.body)) {
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }

        switch (event.type) {
          case "content": {
            // Start a new text block if needed
            if (currentTextIndex === -1) {
              output.content.push({ type: "text", text: "" });
              currentTextIndex = output.content.length - 1;
              stream.push({
                type: "text_start",
                contentIndex: currentTextIndex,
                partial: output,
              });
            }

            const textBlock = output.content[currentTextIndex];
            if (textBlock.type === "text") {
              textBlock.text += event.payload.content;
              stream.push({
                type: "text_delta",
                contentIndex: currentTextIndex,
                delta: event.payload.content,
                partial: output,
              });
            }
            break;
          }

          case "tool_start": {
            // End current text block if any
            if (currentTextIndex !== -1) {
              const textBlock = output.content[currentTextIndex];
              if (textBlock.type === "text") {
                stream.push({
                  type: "text_end",
                  contentIndex: currentTextIndex,
                  content: textBlock.text,
                  partial: output,
                });
              }
              currentTextIndex = -1;
            }

            // Check if this is a thinking tool call
            const isThinking = event.payload.name === "thinking";

            if (isThinking) {
              // Map thinking tool to a thinking content block
              output.content.push({
                type: "thinking",
                thinking: "",
              });
              currentToolIndex = output.content.length - 1;
              toolPartialJson = event.payload.input ?? "";
              stream.push({
                type: "thinking_start",
                contentIndex: currentToolIndex,
                partial: output,
              });
              if (event.payload.input) {
                // Try to extract thought from partial JSON
                const thought = extractThought(event.payload.input);
                if (thought) {
                  const block = output.content[currentToolIndex] as any;
                  block.thinking += thought;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: currentToolIndex,
                    delta: thought,
                    partial: output,
                  });
                }
              }
            } else {
              // Regular tool call
              output.content.push({
                type: "toolCall",
                id: event.payload.toolUseId,
                name: event.payload.name,
                arguments: {},
              });
              currentToolIndex = output.content.length - 1;
              toolPartialJson = event.payload.input ?? "";
              stream.push({
                type: "toolcall_start",
                contentIndex: currentToolIndex,
                partial: output,
              });
              if (event.payload.input) {
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: currentToolIndex,
                  delta: event.payload.input,
                  partial: output,
                });
              }
            }
            break;
          }

          case "tool_input": {
            if (currentToolIndex === -1) break;
            const block = output.content[currentToolIndex];

            if (block.type === "thinking") {
              // Accumulate thinking JSON and extract thought
              toolPartialJson += event.payload.input;
              const thought = extractThought(event.payload.input);
              if (thought) {
                block.thinking += thought;
                stream.push({
                  type: "thinking_delta",
                  contentIndex: currentToolIndex,
                  delta: thought,
                  partial: output,
                });
              }
            } else if (block.type === "toolCall") {
              toolPartialJson += event.payload.input;
              try {
                block.arguments = JSON.parse(toolPartialJson);
              } catch {
                // Partial JSON, keep accumulating
              }
              stream.push({
                type: "toolcall_delta",
                contentIndex: currentToolIndex,
                delta: event.payload.input,
                partial: output,
              });
            }
            break;
          }

          case "tool_stop": {
            if (currentToolIndex === -1) break;
            const block = output.content[currentToolIndex];

            if (block.type === "thinking") {
              // Finalize thinking block
              try {
                const parsed = JSON.parse(toolPartialJson);
                if (parsed.thought) {
                  block.thinking = parsed.thought;
                }
              } catch {
                // Use whatever we accumulated
              }
              stream.push({
                type: "thinking_end",
                contentIndex: currentToolIndex,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              try {
                block.arguments = JSON.parse(toolPartialJson);
              } catch {
                // Use whatever we parsed so far
              }
              output.stopReason = "toolUse";
              stream.push({
                type: "toolcall_end",
                contentIndex: currentToolIndex,
                toolCall: block,
                partial: output,
              });
            }

            currentToolIndex = -1;
            toolPartialJson = "";
            break;
          }

          case "usage": {
            if (event.payload.inputTokens !== undefined) {
              output.usage.input = event.payload.inputTokens;
            }
            if (event.payload.outputTokens !== undefined) {
              output.usage.output = event.payload.outputTokens;
            }
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
            break;
          }

          case "context_usage": {
            // Estimate input tokens from context usage percentage
            const pct =
              event.payload.contextUsagePercentage ??
              event.payload.contextTokens ??
              0;
            if (!output.usage.input && pct > 0) {
              output.usage.input = Math.round(
                (pct / 100) * (model.contextWindow || 200000),
              );
              output.usage.totalTokens =
                output.usage.input +
                output.usage.output +
                output.usage.cacheRead +
                output.usage.cacheWrite;
              calculateCost(model, output.usage);
            }
            break;
          }

          case "error": {
            throw new Error(`Kiro stream error: ${event.payload.message}`);
          }
        }
      }

      // Close any open text block
      if (currentTextIndex !== -1) {
        const textBlock = output.content[currentTextIndex];
        if (textBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: currentTextIndex,
            content: textBlock.text,
            partial: output,
          });
        }
      }

      // Determine stop reason
      const hasToolCalls = output.content.some((b) => b.type === "toolCall");
      if (hasToolCalls) {
        output.stopReason = "toolUse";
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

/**
 * Extract thought text from partial JSON input for the thinking tool.
 * The input arrives as streamed JSON like: {"thought":"step-by-step..."}
 * We try to extract just the new text content.
 */
function extractThought(input: string): string {
  // Simple heuristic: if the input looks like part of the thought value,
  // return it directly. The full JSON will be parsed on tool_stop.
  // Strip JSON structural characters from the streaming chunks.
  return input
    .replace(/^[{"\s]*thought["\s]*:["\s]*/i, "")
    .replace(/["\s]*}$/i, "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

// =============================================================================
// Dynamic Model Discovery
// =============================================================================

async function discoverModels(): Promise<
  {
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
  }[]
> {
  try {
    const models = await listModels();
    if (!models || models.length === 0) return getDefaultModels();

    return models.map((m) => ({
      id: m.modelId,
      name: m.displayName || m.modelId,
      reasoning: true, // Enable thinking tool for all models
      input: ["text" as const, "image" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow || 200000,
      maxTokens: m.maxOutputTokens || 16384,
    }));
  } catch {
    return getDefaultModels();
  }
}

function getDefaultModels() {
  return [
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
    {
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
    {
      id: "claude-opus-4.6",
      name: "Claude Opus 4.6",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
    {
      id: "auto",
      name: "Auto (Kiro selects)",
      reasoning: true,
      input: ["text" as const, "image" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ];
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // Register the Kiro provider
  pi.registerProvider("kiro", {
    baseUrl: "https://q.us-east-1.amazonaws.com",
    apiKey: "KIRO_API_KEY",
    api: "kiro-stream",

    models: getDefaultModels(),

    oauth: {
      name: "Amazon Kiro",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred) => cred.access,
    },

    streamSimple: streamKiro,
  });

  // Register /kiro-quota command to check subscription usage
  pi.registerCommand("kiro-quota", {
    description: "Show Kiro subscription usage quota",
    handler: async (_args, ctx) => {
      try {
        const quota = await getQuota();
        if (quota) {
          ctx.ui.notify(
            `${quota.subscriptionTitle}: ${quota.currentUsage.toLocaleString()}/${quota.usageLimit.toLocaleString()} credits used`,
            "info",
          );
        } else {
          ctx.ui.notify(
            "Could not retrieve Kiro quota. Are you logged in?",
            "warn",
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `Failed to get quota: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // Register /kiro-models command to list available models
  pi.registerCommand("kiro-models", {
    description: "List available Kiro models and update the provider",
    handler: async (_args, ctx) => {
      try {
        const models = await discoverModels();
        const names = models.map((m) => `  ${m.id} (${m.name})`).join("\n");
        ctx.ui.notify(`Available Kiro models:\n${names}`, "info");

        // Re-register provider with discovered models
        pi.registerProvider("kiro", {
          baseUrl: "https://q.us-east-1.amazonaws.com",
          apiKey: "KIRO_API_KEY",
          api: "kiro-stream",
          models,
          oauth: {
            name: "Amazon Kiro",
            login: loginKiro,
            refreshToken: refreshKiroToken,
            getApiKey: (cred) => cred.access,
          },
          streamSimple: streamKiro,
        });

        ctx.ui.notify("Provider updated with discovered models.", "success");
      } catch (error) {
        ctx.ui.notify(
          `Failed to list models: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // Try to discover models on startup (non-blocking)
  (async () => {
    try {
      const hasAuth = await hasToken();
      if (!hasAuth) return;

      const models = await discoverModels();
      if (models.length > 0) {
        pi.registerProvider("kiro", {
          baseUrl: "https://q.us-east-1.amazonaws.com",
          apiKey: "KIRO_API_KEY",
          api: "kiro-stream",
          models,
          oauth: {
            name: "Amazon Kiro",
            login: loginKiro,
            refreshToken: refreshKiroToken,
            getApiKey: (cred) => cred.access,
          },
          streamSimple: streamKiro,
        });
      }
    } catch {
      // Silently fail - default models are already registered
    }
  })();
}
