/**
 * AWS Extension for pi
 *
 * Provides safe AWS access through custom tools instead of the raw AWS CLI.
 *
 * Features:
 * - Blocks `aws` CLI calls in bash commands (redirects to use the tools below)
 * - Lists Lambda functions and fetches configs
 * - Discovers Lambda log groups and retrieves CloudWatch logs
 * - Lists DynamoDB tables and performs get/query/scan operations
 *
 * Configuration:
 *   REQUIRED: Create ~/.pi/agent/aws-config.json with a named profile:
 *     { "profile": "my-profile", "region": "us-east-1" }
 *
 *   The profile must match a named profile in ~/.aws/config or ~/.aws/credentials.
 *   The extension will not load without it — no fallback to default profiles.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AwsConfig {
  profile?: string;
  region?: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

let awsConfig: AwsConfig | null = null;
let configError: Error | null = null;

// AWS SDK clients (lazily initialized)
let lambdaClient: Awaited<ReturnType<typeof createLambdaClient>> | null = null;
let dynamoClient: Awaited<ReturnType<typeof createDynamoClient>> | null = null;
let cwLogsClient: Awaited<ReturnType<typeof createCWLogsClient>> | null = null;

// ─── Config Loading ──────────────────────────────────────────────────────────

class AwsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsConfigError";
  }
}

async function loadConfig(): Promise<AwsConfig> {
  if (awsConfig) return awsConfig;
  if (configError) throw configError;

  const configPath = join(homedir(), ".pi", "agent", "aws-config.json");
  let data: string;
  try {
    data = await readFile(configPath, "utf-8");
  } catch {
    configError = new AwsConfigError(
      `AWS config file not found at ${configPath}. ` +
      "Create it with:\n" +
      '  { "profile": "your-aws-profile", "region": "us-east-1" }\n' +
      "The profile must match a named profile in ~/.aws/config or ~/.aws/credentials."
    );
    throw configError;
  }

  let parsed: AwsConfig;
  try {
    parsed = JSON.parse(data) as AwsConfig;
  } catch {
    configError = new AwsConfigError(`Invalid JSON in ${configPath}.`);
    throw configError;
  }

  if (!parsed.profile) {
    configError = new AwsConfigError(
      `Missing "profile" in ${configPath}. ` +
      "A named AWS profile is required. Add it like:\n" +
      '  { "profile": "your-aws-profile", "region": "us-east-1" }'
    );
    throw configError;
  }

  awsConfig = parsed;
  return awsConfig;
}

// ─── AWS Client Factory ──────────────────────────────────────────────────────

async function createLambdaClient() {
  const { LambdaClient } = await import("@aws-sdk/client-lambda");
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const config = await loadConfig();
  const region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
  return new LambdaClient({ region, credentials: fromIni({ profile: config.profile }) });
}

async function createDynamoClient() {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const config = await loadConfig();
  const region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
  return new DynamoDBClient({ region, credentials: fromIni({ profile: config.profile }) });
}

async function createCWLogsClient() {
  const { CloudWatchLogsClient } = await import("@aws-sdk/client-cloudwatch-logs");
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const config = await loadConfig();
  const region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
  return new CloudWatchLogsClient({ region, credentials: fromIni({ profile: config.profile }) });
}

async function ensureClients() {
  // Always load config first so it throws eagerly if missing
  await loadConfig();
  if (!lambdaClient) lambdaClient = await createLambdaClient();
  if (!dynamoClient) dynamoClient = await createDynamoClient();
  if (!cwLogsClient) cwLogsClient = await createCWLogsClient();
}

// ─── Truncation Helpers ──────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 50_000;
const DEFAULT_MAX_LINES = 2_000;

function truncateHead(
  text: string,
  opts: { maxLines?: number; maxBytes?: number } = {},
): { content: string; truncated: boolean; totalLines: number; totalBytes: number } {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalLines = text.split("\n").length;
  const totalBytes = Buffer.byteLength(text, "utf-8");

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false, totalLines, totalBytes };
  }

  // Truncate by lines first
  let lines = text.split("\n");
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
  }

  // Then by bytes
  let content = lines.join("\n");
  const encoder = new TextEncoder();
  let encoded = encoder.encode(content);
  if (encoded.length > maxBytes) {
    encoded = encoded.slice(0, maxBytes);
    content = new TextDecoder("utf-8", { fatal: false }).decode(encoded);
    // Remove any broken trailing character
    content = content.replace(/\uFFFD+$/, "");
  }

  return { content, truncated: true, totalLines, totalBytes };
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Bash Interception ────────────────────────────────────────────────────
  // Block any bash command that uses the `aws` CLI, directing to our tools.

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;

      // Match aws as a command word (not part of a larger word, not in comments)
      // We check for patterns like: `aws ` `|aws ` `;aws ` `&&aws ` at start or after pipes/commands
      // Skip commands that are clearly NOT actual AWS CLI usage
      const installPatterns = /(?:^|\s)(?:npm|pip|brew|yum|apt|apt-get|dnf|pacman)\s+(?:install|update|remove)/;
      const envOnlyPattern = /^\s*(?:export|set)\s+AWS_/;

      if (installPatterns.test(cmd) || envOnlyPattern.test(cmd)) return;

      // Match aws as an invoked command word, excluding non-CLI uses
      // Patterns: `aws ` at line start, `| aws `, `; aws `, `&& aws `, `$(aws `
      const awsPattern = /(?:^|\||;|&&|\$\()\s*aws\b/;
      const commentPattern = /#.*$/;

      // Strip comments from the command before checking
      const stripped = cmd.replace(commentPattern, "");

      if (awsPattern.test(stripped)) {
        ctx.ui.notify("Blocked aws CLI call — use the aws_* tools instead", "warning");
        return {
          block: true,
          reason:
            "Direct AWS CLI calls are blocked. Use the available tools: " +
            "aws_list_lambdas, aws_get_lambda_config, aws_get_lambda_log_group, " +
            "aws_get_logs, aws_list_dynamo_tables, aws_dynamo_get_item, " +
            "aws_dynamo_query, aws_dynamo_scan, aws_get_caller_identity. " +
            "These tools use the configured AWS profile from ~/.pi/agent/aws-config.json.",
        };
      }
    }
  });

  // ── Tool: List Lambda Functions ──────────────────────────────────────────

  pi.registerTool({
    name: "aws_list_lambdas",
    label: "AWS List Lambda Functions",
    description:
      "List AWS Lambda functions in the configured account/region. " +
      "Optionally filter by function name prefix (e.g., 'my-service-'). " +
      "Returns function names, runtime, last modified date, and handler.",
    promptSnippet: "List Lambda functions (with optional prefix filter)",
    promptGuidelines: [
      "Use aws_list_lambdas to discover Lambda functions instead of the AWS CLI.",
    ],
    parameters: Type.Object({
      prefix: Type.Optional(
        Type.String({ description: "Optional function name prefix to filter by" }),
      ),
      maxItems: Type.Optional(
        Type.Number({
          description: "Maximum number of functions to return (default 50, max 100)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await ensureClients();
      const { ListFunctionsCommand } = await import("@aws-sdk/client-lambda");

      const maxItems = Math.min(params.maxItems ?? 50, 100);
      const functions: Array<Record<string, unknown>> = [];
      let marker: string | undefined;

      try {
        do {
          const cmd = new ListFunctionsCommand({
            MaxItems: maxItems,
            Marker: marker,
          });
          const resp = await lambdaClient!.send(cmd);
          const filtered = params.prefix
            ? (resp.Functions ?? []).filter((f: { FunctionName?: string }) =>
                f.FunctionName?.startsWith(params.prefix!),
              )
            : (resp.Functions ?? []);

          for (const fn of filtered) {
            functions.push({
              functionName: fn.FunctionName,
              runtime: fn.Runtime,
              handler: fn.Handler,
              memory: fn.MemorySize,
              timeout: fn.Timeout,
              lastModified: fn.LastModified,
              arn: fn.FunctionArn,
              state: fn.State,
            });
          }
          marker = resp.NextMarker;
        } while (marker && functions.length < maxItems);

        const truncated = functions.length > maxItems;
        const results = truncated ? functions.slice(0, maxItems) : functions;

        const lines = results.map(
          (f) =>
            `  ${f.functionName}  (${f.runtime}, ${f.memory}MB, ${f.timeout}s, modified: ${f.lastModified ?? "N/A"})`,
        );
        let text = `Found ${truncated ? `${maxItems}+` : functions.length} function(s)`;
        if (params.prefix) text += ` matching prefix "${params.prefix}"`;
        text += ":\n" + lines.join("\n");

        return {
          content: [{ type: "text", text: truncateHead(text, { maxLines: 500 }).content }],
          details: { functions: results.slice(0, 20) },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to list Lambda functions: ${msg}`);
      }
    },
  });

  // ── Tool: Get Lambda Config ──────────────────────────────────────────────

  pi.registerTool({
    name: "aws_get_lambda_config",
    label: "AWS Get Lambda Config",
    description:
      "Get detailed configuration for a specific AWS Lambda function. " +
      "Returns runtime, handler, memory, timeout, environment variables (redacted), " +
      "VPC config, IAM role, and more.",
    promptSnippet: "Get Lambda function configuration details",
    promptGuidelines: [
      "Use aws_get_lambda_config to inspect a Lambda function's settings.",
    ],
    parameters: Type.Object({
      functionName: Type.String({ description: "Name or ARN of the Lambda function" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      await ensureClients();
      const { GetFunctionConfigurationCommand } = await import("@aws-sdk/client-lambda");

      try {
        const cmd = new GetFunctionConfigurationCommand({
          FunctionName: params.functionName,
        });
        const resp = await lambdaClient!.send(cmd);

        const envVars = resp.Environment?.Variables
          ? Object.keys(resp.Environment.Variables).reduce(
              (acc: Record<string, string>, k: string) => {
                acc[k] = "***redacted***";
                return acc;
              },
              {},
            )
          : {};

        const config: Record<string, unknown> = {
          functionName: resp.FunctionName,
          arn: resp.FunctionArn,
          role: resp.Role,
          handler: resp.Handler,
          runtime: resp.Runtime,
          memory: resp.MemorySize,
          timeout: resp.Timeout,
          description: resp.Description,
          lastModified: resp.LastModified,
          version: resp.Version,
          state: resp.State,
          stateReason: resp.StateReason,
          lastUpdateStatus: resp.LastUpdateStatus,
          codeSize: resp.CodeSize,
          architectures: resp.Architectures,
          environmentVariables: envVars,
          vpcConfig: resp.VpcConfig
            ? {
                subnetIds: resp.VpcConfig.SubnetIds,
                securityGroupIds: resp.VpcConfig.SecurityGroupIds,
                vpcId: resp.VpcConfig.VpcId,
              }
            : "No VPC",
          tracingMode: resp.TracingConfig?.Mode ?? "N/A",
          layers: resp.Layers?.map((l: { Arn?: string }) => l.Arn) ?? [],
          ephemeralStorageSize: resp.EphemeralStorage?.Size ?? "N/A",
          snapStart: resp.SnapStart?.ApplyOn ?? "N/A",
        };

        const lines = Object.entries(config).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
        let text = `Configuration for ${params.functionName}:\n${lines.join("\n")}`;

        return {
          content: [{ type: "text", text: truncateHead(text).content }],
          details: { config },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to get Lambda config for "${params.functionName}": ${msg}`);
      }
    },
  });

  // ── Tool: Get Lambda Log Group ───────────────────────────────────────────

  pi.registerTool({
    name: "aws_get_lambda_log_group",
    label: "AWS Get Lambda Log Group",
    description:
      "Find the CloudWatch log group for a Lambda function. " +
      "Returns the log group name(s), creation time, retention policy, and # of log streams. " +
      "Lambda functions typically have log groups named /aws/lambda/<function-name>.",
    promptSnippet: "Find CloudWatch log group for a Lambda function",
    promptGuidelines: [
      "Use aws_get_lambda_log_group before aws_get_logs to find the log group name.",
    ],
    parameters: Type.Object({
      functionName: Type.String({ description: "Name of the Lambda function" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      await ensureClients();
      const { DescribeLogGroupsCommand } = await import("@aws-sdk/client-cloudwatch-logs");

      try {
        const cmd = new DescribeLogGroupsCommand({
          logGroupNamePrefix: `/aws/lambda/${params.functionName}`,
        });
        const resp = await cwLogsClient!.send(cmd);

        if (!resp.logGroups || resp.logGroups.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No log group found for function "${params.functionName}". ` +
                  `Expected prefix: /aws/lambda/${params.functionName}`,
              },
            ],
            details: { logGroups: [] },
          };
        }

        const groups = resp.logGroups.map(
          (g: {
            logGroupName?: string;
            creationTime?: number;
            retentionInDays?: number;
            storedBytes?: number;
            metricFilterCount?: number;
          }) => ({
            logGroupName: g.logGroupName,
            creationTime: g.creationTime ? new Date(g.creationTime).toISOString() : "N/A",
            retentionInDays: g.retentionInDays ?? "Never expire",
            storedBytes: g.storedBytes ?? 0,
            metricFilterCount: g.metricFilterCount ?? 0,
          }),
        );

        const lines = groups.map(
          (g: Record<string, unknown>) =>
            `  ${g.logGroupName}  (retention: ${g.retentionInDays}, created: ${g.creationTime})`,
        );
        const text = `Log groups for ${params.functionName}:\n${lines.join("\n")}`;

        return {
          content: [{ type: "text", text }],
          details: { logGroups: groups },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to find log group for "${params.functionName}": ${msg}`);
      }
    },
  });

  // ── Tool: Get Logs from Log Group ────────────────────────────────────────

  pi.registerTool({
    name: "aws_get_logs",
    label: "AWS Get Logs",
    description:
      "Retrieve log events from a CloudWatch log group. " +
      "Supports optional start/end time filtering, and a limit on events returned. " +
      "Times are ISO 8601 strings like '2025-01-15T10:00:00Z'. Defaults to last 1 hour.",
    promptSnippet: "Get logs from a CloudWatch log group",
    promptGuidelines: [
      "Use aws_get_logs to fetch CloudWatch logs. First use aws_get_lambda_log_group to discover log groups.",
    ],
    parameters: Type.Object({
      logGroupName: Type.String({ description: "CloudWatch log group name (e.g., /aws/lambda/my-func)" }),
      limit: Type.Optional(
        Type.Number({ description: "Max log events to return (default 50, max 200)" }),
      ),
      startTime: Type.Optional(
        Type.String({
          description:
            "ISO 8601 start time (e.g., '2025-01-15T10:00:00Z'). " +
            "Defaults to 1 hour ago if not specified.",
        }),
      ),
      endTime: Type.Optional(
        Type.String({
          description:
            "ISO 8601 end time (e.g., '2025-01-15T11:00:00Z'). " +
            "Defaults to now if not specified.",
        }),
      ),
      filterPattern: Type.Optional(
        Type.String({
          description:
            "Optional CloudWatch filter pattern (e.g., 'ERROR' or '?Exception ?Traceback')",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      await ensureClients();
      const { FilterLogEventsCommand } = await import("@aws-sdk/client-cloudwatch-logs");

      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const startTime = params.startTime ? new Date(params.startTime).getTime() : oneHourAgo;
      const endTime = params.endTime ? new Date(params.endTime).getTime() : now;
      const limit = Math.min(params.limit ?? 50, 200);

      try {
        const cmd = new FilterLogEventsCommand({
          logGroupName: params.logGroupName,
          startTime,
          endTime,
          limit,
          filterPattern: params.filterPattern,
        });
        const resp = await cwLogsClient!.send(cmd);

        if (!resp.events || resp.events.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No log events found in ${params.logGroupName} for the specified time range.`,
              },
            ],
            details: { events: [] },
          };
        }

        const events = resp.events.map(
          (e: { timestamp?: number; message?: string; logStreamName?: string }) => ({
            timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : "N/A",
            logStreamName: e.logStreamName ?? "N/A",
            message: (e.message ?? "").trimEnd(),
          }),
        );

        const lines = events.map(
          (e: { timestamp: string; logStreamName: string; message: string }) =>
            `[${e.timestamp}] [${e.logStreamName}] ${e.message}`,
        );

        const truncated = truncateTail_(lines.join("\n"), { maxLines: 300, maxBytes: 40_000 });
        let text = `${events.length} log event(s) from ${params.logGroupName}:\n${truncated.content}`;
        if (truncated.truncated) {
          text += `\n\n[Showing ${truncated.outputLines}/${truncated.totalLines} lines, ${truncated.outputBytes}/${truncated.totalBytes} bytes]`;
        }

        return {
          content: [{ type: "text", text }],
          details: {
            events: events.slice(0, 30),
            totalCount: events.length,
            logGroup: params.logGroupName,
          },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to get logs from "${params.logGroupName}": ${msg}`);
      }
    },
  });

  // ── Tool: List DynamoDB Tables ───────────────────────────────────────────

  pi.registerTool({
    name: "aws_list_dynamo_tables",
    label: "AWS List DynamoDB Tables",
    description:
      "List DynamoDB tables in the configured account/region. " +
      "Returns table names, status, item count, size, and primary key schema.",
    promptSnippet: "List DynamoDB tables",
    promptGuidelines: [
      "Use aws_list_dynamo_tables to discover DynamoDB tables.",
    ],
    parameters: Type.Object({
      maxItems: Type.Optional(
        Type.Number({ description: "Maximum number of tables to return (default 50, max 100)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      await ensureClients();
      const { ListTablesCommand } = await import("@aws-sdk/client-dynamodb");

      const maxItems = Math.min(params.maxItems ?? 50, 100);
      const tableNames: string[] = [];
      let startTable: string | undefined;

      try {
        do {
          const cmd = new ListTablesCommand({
            Limit: Math.min(100, maxItems - tableNames.length),
            ExclusiveStartTableName: startTable,
          });
          const resp = await dynamoClient!.send(cmd);
          if (resp.TableNames) tableNames.push(...resp.TableNames);
          startTable = resp.LastEvaluatedTableName;
        } while (startTable && tableNames.length < maxItems);

        const text = `Found ${tableNames.length} DynamoDB table(s):\n` +
          tableNames.map((t) => `  ${t}`).join("\n");

        return {
          content: [{ type: "text", text }],
          details: { tableNames },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to list DynamoDB tables: ${msg}`);
      }
    },
  });

  // ── Tool: DynamoDB Get Item ──────────────────────────────────────────────

  pi.registerTool({
    name: "aws_dynamo_get_item",
    label: "AWS DynamoDB Get Item",
    description:
      "Get a single item from a DynamoDB table by its primary key. " +
      "Provide the key as a JSON object matching the table's schema " +
      '(e.g., {"pk": {"S": "user#123"}, "sk": {"S": "meta"}}). ' +
      "Returns the item as a JSON object.",
    promptSnippet: "Get a single item from a DynamoDB table",
    promptGuidelines: [
      "Use aws_dynamo_get_item to fetch a single item by key. Use aws_dynamo_query for indexed lookups.",
      "Key values must use DynamoDB JSON format: { 'pk': { 'S': 'value' }, 'sk': { 'N': '123' } }.",
    ],
    parameters: Type.Object({
      tableName: Type.String({ description: "Name of the DynamoDB table" }),
      key: Type.String({
        description:
          'Primary key in DynamoDB JSON format. ' +
          'Example: {"pk": {"S": "user#123"}, "sk": {"S": "meta"}} ' +
          'for string keys, {"id": {"N": "42"}} for numeric keys.',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      await ensureClients();
      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");

      let key: Record<string, unknown>;
      try {
        key = JSON.parse(params.key);
      } catch {
        throw new Error(
          'Invalid key JSON. Use DynamoDB JSON format, e.g.: {"pk": {"S": "user#123"}}',
        );
      }

      try {
        const cmd = new GetItemCommand({ TableName: params.tableName, Key: key });
        const resp = await dynamoClient!.send(cmd);

        if (!resp.Item) {
          return {
            content: [{ type: "text", text: `No item found in ${params.tableName} with the given key.` }],
            details: { found: false, tableName: params.tableName, key },
          };
        }

        const item = unmarshallItem(resp.Item);
        const text = `Item from ${params.tableName}:\n${JSON.stringify(item, null, 2)}`;

        return {
          content: [{ type: "text", text }],
          details: { found: true, tableName: params.tableName, key, item },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to get item from "${params.tableName}": ${msg}`);
      }
    },
  });

  // ── Tool: DynamoDB Query ─────────────────────────────────────────────────

  pi.registerTool({
    name: "aws_dynamo_query",
    label: "AWS DynamoDB Query",
    description:
      "Query a DynamoDB table using a key condition expression. " +
      "Provide expression attribute values in DynamoDB JSON format. " +
      "Example: keyConditionExpression='pk = :pk AND begins_with(sk, :prefix)', " +
      "expressionAttributeValues='{\":pk\": {\"S\": \"user#123\"}, \":prefix\": {\"S\": \"order#\"}}'. " +
      "Optionally specify an index name for GSI/LSI queries, and a limit.",
    promptSnippet: "Query a DynamoDB table",
    promptGuidelines: [
      "Use aws_dynamo_query for indexed DynamoDB lookups. Prefer query over scan.",
      "Expression attribute values must be in DynamoDB JSON format.",
    ],
    parameters: Type.Object({
      tableName: Type.String({ description: "Name of the DynamoDB table" }),
      keyConditionExpression: Type.String({
        description: "DynamoDB key condition expression (e.g., 'pk = :pk AND begins_with(sk, :prefix)')",
      }),
      expressionAttributeValues: Type.String({
        description:
          'Expression attribute values in DynamoDB JSON format. ' +
          'Example: {\":pk\": {\"S\": \"user#123\"}}',
      }),
      indexName: Type.Optional(
        Type.String({ description: "Optional GSI/LSI index name for the query" }),
      ),
      filterExpression: Type.Optional(
        Type.String({ description: "Optional filter expression to apply after the query" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of items to return (default 50, max 200)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      await ensureClients();
      const { QueryCommand } = await import("@aws-sdk/client-dynamodb");

      let attrValues: Record<string, unknown>;
      try {
        attrValues = JSON.parse(params.expressionAttributeValues);
      } catch {
        throw new Error(
          'Invalid expressionAttributeValues JSON. Use DynamoDB format, ' +
          'e.g.: {":pk": {"S": "user#123"}}',
        );
      }

      const limit = Math.min(params.limit ?? 50, 200);

      try {
        const cmd = new QueryCommand({
          TableName: params.tableName,
          KeyConditionExpression: params.keyConditionExpression,
          ExpressionAttributeValues: attrValues,
          IndexName: params.indexName,
          FilterExpression: params.filterExpression,
          Limit: limit,
        });
        const resp = await dynamoClient!.send(cmd);

        const items = (resp.Items ?? []).map(unmarshallItem);
        const text =
          `Query returned ${items.length} item(s) from ${params.tableName}` +
          (params.indexName ? ` (using index: ${params.indexName})` : "") +
          ":\n" +
          items.map((item, i) => `  [${i + 1}] ${JSON.stringify(item)}`).join("\n");

        return {
          content: [{ type: "text", text: truncateHead(text, { maxLines: 300 }).content }],
          details: {
            tableName: params.tableName,
            indexName: params.indexName,
            count: items.length,
            items: items.slice(0, 30),
          },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to query "${params.tableName}": ${msg}`);
      }
    },
  });

  // ── Tool: DynamoDB Scan ──────────────────────────────────────────────────

  pi.registerTool({
    name: "aws_dynamo_scan",
    label: "AWS DynamoDB Scan",
    description:
      "Scan a DynamoDB table (returns all items up to the limit). " +
      "Use with caution — scans read the entire table and can be expensive. " +
      "Prefer aws_dynamo_query when you know the key condition. " +
      "Optionally specify a filter expression to narrow results.",
    promptSnippet: "Scan a DynamoDB table",
    promptGuidelines: [
      "Use aws_dynamo_scan only as a last resort. Prefer aws_dynamo_query when possible.",
      "Scans are expensive — keep limits low.",
    ],
    parameters: Type.Object({
      tableName: Type.String({ description: "Name of the DynamoDB table" }),
      filterExpression: Type.Optional(
        Type.String({
          description:
            "Optional filter expression (e.g., 'attribute_exists(updatedAt)')",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of items to return (default 20, max 100)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate) {
      await ensureClients();
      const { ScanCommand } = await import("@aws-sdk/client-dynamodb");

      const limit = Math.min(params.limit ?? 20, 100);

      try {
        const cmd = new ScanCommand({
          TableName: params.tableName,
          FilterExpression: params.filterExpression,
          Limit: limit,
        });
        const resp = await dynamoClient!.send(cmd);

        const items = (resp.Items ?? []).map(unmarshallItem);
        const text =
          `Scan returned ${items.length} item(s) from ${params.tableName}` +
          (resp.LastEvaluatedKey ? " (more items available, use query for pagination)" : "") +
          ":\n" +
          items.map((item, i) => `  [${i + 1}] ${JSON.stringify(item)}`).join("\n");

        const truncated = truncateHead(text, { maxLines: 300 });
        return {
          content: [{ type: "text", text: truncated.content }],
          details: {
            tableName: params.tableName,
            count: items.length,
            hasMore: !!resp.LastEvaluatedKey,
            items: items.slice(0, 30),
          },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to scan "${params.tableName}": ${msg}`);
      }
    },
  });

  // ── Tool: Get Caller Identity ─────────────────────────────────────────────

  pi.registerTool({
    name: "aws_get_caller_identity",
    label: "AWS Get Caller Identity",
    description:
      "Get the AWS identity (account, ARN, user/role) of the currently configured credentials. " +
      "Equivalent to `aws sts get-caller-identity`.",
    promptSnippet: "Get the current AWS caller identity",
    promptGuidelines: [
      "Use aws_get_caller_identity to check which AWS account/role/user is configured.",
    ],
    parameters: Type.Object({}),
    async execute() {
      await loadConfig();
      const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const { fromIni } = await import("@aws-sdk/credential-providers");
      const config = awsConfig!;
      const region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
      const client = new STSClient({ region, credentials: fromIni({ profile: config.profile }) });

      try {
        const resp = await client.send(new GetCallerIdentityCommand({}));
        const identity = {
          account: resp.Account,
          arn: resp.Arn,
          userId: resp.UserId,
        };
        const text = `AWS Caller Identity:\n  Account: ${identity.account}\n  ARN: ${identity.arn}\n  UserId: ${identity.userId}`;
        return {
          content: [{ type: "text", text }],
          details: { identity },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to get caller identity: ${msg}`);
      }
    },
  });

  // ── Notify on load ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("AWS extension loaded (9 tools, aws CLI blocked)", "info");
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Simple DynamoDB item unmarshaller — converts DynamoDB JSON to plain JSON.
 * Example: { "name": { "S": "Alice" }, "age": { "N": "30" } } -> { name: "Alice", age: 30 }
 */
function unmarshallItem(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    result[key] = unmarshallValue(value as Record<string, unknown>);
  }
  return result;
}

function unmarshallValue(value: Record<string, unknown>): unknown {
  if (!value || typeof value !== "object") return value;

  if ("S" in value) return String(value.S);
  if ("N" in value) {
    const n = Number(value.N);
    return Number.isNaN(n) ? value.N : n;
  }
  if ("BOOL" in value) return Boolean(value.BOOL);
  if ("NULL" in value) return null;
  if ("SS" in value) return value.SS;
  if ("NS" in value) return (value.NS as string[]).map(Number);
  if ("L" in value) return (value.L as Record<string, unknown>[]).map(unmarshallValue);
  if ("M" in value) {
    const m = value.M as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) {
      result[k] = unmarshallValue(v as Record<string, unknown>);
    }
    return result;
  }
  // Binary, sets, etc. — return raw
  return value;
}

/**
 * Truncate keeping the *tail* of the content (good for logs).
 */
function truncateTail_(
  text: string,
  opts: { maxLines?: number; maxBytes?: number } = {},
): { content: string; truncated: boolean; totalLines: number; totalBytes: number; outputLines: number; outputBytes: number } {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalLines = text.split("\n").length;
  const totalBytes = Buffer.byteLength(text, "utf-8");

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    const result = { content: text, truncated: false, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes };
    return result;
  }

  let lines = text.split("\n");
  let keptLines = lines;
  if (lines.length > maxLines) {
    keptLines = lines.slice(lines.length - maxLines);
  }

  let content = keptLines.join("\n");
  const encoder = new TextEncoder();
  let encoded = encoder.encode(content);
  if (encoded.length > maxBytes) {
    encoded = encoded.slice(encoded.length - maxBytes);
    content = new TextDecoder("utf-8", { fatal: false }).decode(encoded);
    // Remove leading broken character
    content = content.replace(/^\uFFFD+/, "");
    // If we lost the first line's beginning, add a marker
    if (!content.startsWith("[") && !content.includes("\n")) {
      content = "…" + content;
    }
  }

  const outputLines = content.split("\n").length;
  const outputBytes = Buffer.byteLength(content, "utf-8");
  return { content, truncated: true, totalLines, totalBytes, outputLines, outputBytes };
}
