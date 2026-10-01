
import {
  loadServiceConfig,
  normalizeLegacyMcpConfig,
  z,
} from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { fetchWithRetry } from "./vendor/retry/index.js";
import { createHash } from "node:crypto";
import { withSlackEditLock, type SlackEditLockOptions } from "./edit-lock.js";

const SlackConfigSchema = z.object({
  slack: z
    .object({
      userToken: z.string().optional(),
      botToken: z.string().optional(),
      teamId: z.string().optional(),
      signingSecret: z.string().optional(),
    })
    .optional(),
});

type SlackConfig = z.infer<typeof SlackConfigSchema>;

type ExhaustiveMessageReadOptions = {
  limit?: number;
  oldest?: string;
  latest?: string;
  cursor?: string;
  maxPages?: number;
};

type SlackMessagePage = {
  ok?: boolean;
  messages?: unknown[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ExhaustiveMessageResult = SlackMessagePage & {
  messages: unknown[];
  pages_fetched: number;
  complete: true;
};

const DEFAULT_EXHAUSTIVE_MESSAGE_MAX_PAGES = 20;
const MAX_EXHAUSTIVE_MESSAGE_PAGES = 100;

export function slackMessageTextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const cache = new PluginCache({
  namespace: "slack-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

function channelCachePattern(namespace: "history" | "thread", channelId: string): RegExp {
  const escapedChannelId = channelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${namespace}.*channel=${escapedChannelId}`); // nosemgrep: detect-non-literal-regexp
}

const SLACK_TS_PATTERN = /^\d+\.\d+$/;

export interface ExhaustiveThreadOptions {
  oldest?: string;
  latest?: string;
  limit?: number;
  maxPages?: number;
  maxMessages?: number;
}

export type ExhaustiveThreadMessage = Record<string, unknown> & {
  ts: string;
  thread_ts?: string;
};

export interface ExhaustiveThreadResult {
  ok: true;
  messages: ExhaustiveThreadMessage[];
  has_more: false;
  response_metadata: { next_cursor: "" };
  complete: true;
  page_count: number;
}

function incompleteThreadCoverage(reason: string): Error {
  return new Error(
    `Slack thread coverage incomplete: ${reason}. Do not infer that a reply is absent.`,
  );
}

function positiveIntegerWithin(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return resolved;
}

export class SlackMCPClient {
  private config: SlackConfig;

  constructor(configOverride?: SlackConfig) {
    if (configOverride) {
      this.config = SlackConfigSchema.parse(configOverride);
      return;
    }

    const raw = loadServiceConfig("slack-manager");
    const normalized = normalizeLegacyMcpConfig(raw, {
      "slack.userToken": "SLACK_USER_TOKEN",
      "slack.botToken": "SLACK_BOT_TOKEN",
      "slack.teamId": "SLACK_TEAM_ID",
      "slack.signingSecret": "SLACK_SIGNING_SECRET",
    });
    this.config = SlackConfigSchema.parse(normalized);
  }


  disableCache(): void {
    cache.disable();
  }

  enableCache(): void {
    cache.enable();
  }

  getCacheStats() {
    return cache.getStats();
  }

  clearCache(): number {
    return cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }


  private getToken(): string {
    const userToken = this.config.slack?.userToken;
    const botToken = this.config.slack?.botToken;
    const token = userToken || botToken;

    if (!token) {
      throw new Error(
        'No Slack token configured. config.json must use the v2.0 flat format: ' +
        '{ "slack": { "userToken": "xoxp-...", "botToken": "xoxb-..." } }'
      );
    }
    return token;
  }

  private getBotToken(): string {
    const botToken = this.config.slack?.botToken;

    if (!botToken) {
      throw new Error(
        'No Slack bot token configured. config.json must use the v2.0 flat format: ' +
        '{ "slack": { "botToken": "xoxb-..." } }'
      );
    }
    return botToken;
  }


  private async listChannelsDirect(options?: {
    limit?: number;
    cursor?: string;
    types?: string;
    includeArchived?: boolean;
  }): Promise<any> {
    const token = this.getToken();
    const params = new URLSearchParams();

    params.set("types", options?.types || "public_channel");
    params.set("exclude_archived", options?.includeArchived ? "false" : "true");

    if (options?.limit) {
      params.set("limit", Math.min(options.limit, 1000).toString());
    }
    if (options?.cursor) {
      params.set("cursor", options.cursor);
    }

    try {
      const response = await fetchWithRetry(
        `https://slack.com/api/conversations.list?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.conversations.list",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "missing_scope") {
          throw new Error(
            "Channel listing requires channels:read scope. Update your Slack app OAuth permissions."
          );
        }
        if (result.error === "not_allowed_token_type") {
          throw new Error(
            "Channel listing requires a user token (xoxp-) or bot token (xoxb-)."
          );
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(
            `Rate limited by Slack API. Retry after ${retryAfter} seconds.`
          );
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async listChannels(options?: {
    limit?: number;
    cursor?: string;
    includePrivate?: boolean;
    includeArchived?: boolean;
  }): Promise<any> {
    const includePrivate = options?.includePrivate ?? false;
    const includeArchived = options?.includeArchived ?? false;
    const cacheKey = createCacheKey("channels", {
      limit: options?.limit,
      cursor: options?.cursor,
      includePrivate,
      includeArchived,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => this.listChannelsDirect({
        limit: options?.limit,
        cursor: options?.cursor,
        types: includePrivate ? "public_channel,private_channel" : "public_channel",
        includeArchived,
      }),
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  private async getChannelHistoryDirect(
    channelId: string,
    limit?: number,
    oldest?: string,
    latest?: string,
    cursor?: string,
  ): Promise<any> {
    const token = this.getToken();
    const params = new URLSearchParams();

    params.set("channel", channelId);
    if (limit) {
      params.set("limit", Math.min(limit, 1000).toString());
    }
    if (oldest) {
      params.set("oldest", oldest);
    }
    if (latest) {
      params.set("latest", latest);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    try {
      const response = await fetchWithRetry(
        `https://slack.com/api/conversations.history?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.conversations.history",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found or not accessible.`);
        }
        if (result.error === "not_in_channel") {
          throw new Error(`Not a member of channel ${channelId}.`);
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(
            `Rate limited by Slack API. Retry after ${retryAfter} seconds.`
          );
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async getChannelHistory(
    channelId: string,
    limit?: number,
    oldest?: string,
    latest?: string,
    cursor?: string,
  ): Promise<any> {
    const cacheKey = createCacheKey("history", { channel: channelId, limit, oldest, latest, cursor });

    return cache.getOrFetch(
      cacheKey,
      async () => this.getChannelHistoryDirect(channelId, limit, oldest, latest, cursor),
      { ttl: TTL.FIVE_MINUTES }
    );
  }

  async getAllChannelHistory(
    channelId: string,
    options: ExhaustiveMessageReadOptions = {},
  ): Promise<ExhaustiveMessageResult> {
    return this.getAllMessagePages(
      "Slack channel history",
      options.cursor,
      options.maxPages,
      (cursor) => this.getChannelHistoryDirect(
        channelId,
        options.limit,
        options.oldest,
        options.latest,
        cursor,
      ),
    );
  }

  private async getThreadRepliesDirect(
    channelId: string,
    threadTs: string,
    limit?: number,
    oldest?: string,
    latest?: string,
    cursor?: string,
  ): Promise<any> {
    const token = this.getToken();
    const params = new URLSearchParams();

    params.set("channel", channelId);
    params.set("ts", threadTs);
    if (limit) {
      params.set("limit", Math.min(limit, 1000).toString());
    }
    if (oldest) {
      params.set("oldest", oldest);
    }
    if (latest) {
      params.set("latest", latest);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    try {
      const response = await fetchWithRetry(
        `https://slack.com/api/conversations.replies?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.conversations.replies",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "thread_not_found") {
          throw new Error(
            `Thread ${threadTs} not found in channel ${channelId}.`
          );
        }
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found or not accessible.`);
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(
            `Rate limited by Slack API. Retry after ${retryAfter} seconds.`
          );
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async getThreadReplies(
    channelId: string,
    threadTs: string,
    limit?: number,
    oldest?: string,
    latest?: string,
    cursor?: string,
  ): Promise<any> {
    const cacheKey = createCacheKey("thread", {
      channel: channelId,
      ts: threadTs,
      limit,
      oldest,
      latest,
      cursor,
    });

    return cache.getOrFetch(
      cacheKey,
      () => this.getThreadRepliesDirect(channelId, threadTs, limit, oldest, latest, cursor),
      { ttl: TTL.FIVE_MINUTES }
    );
  }

  async getThreadRepliesExhaustive(
    channelId: string,
    threadTs: string,
    options: ExhaustiveThreadOptions = {},
  ): Promise<ExhaustiveThreadResult> {
    const limit = positiveIntegerWithin(options.limit, 100, "limit", 1000);
    const maxPages = positiveIntegerWithin(options.maxPages, 100, "maxPages", 1000);
    const maxMessages = positiveIntegerWithin(
      options.maxMessages,
      10_000,
      "maxMessages",
      100_000,
    );
    const messages: ExhaustiveThreadMessage[] = [];
    const seenMessageTimestamps = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      let rawPage: unknown;
      try {
        rawPage = await this.getThreadRepliesDirect(
          channelId,
          threadTs,
          limit,
          options.oldest,
          options.latest,
          cursor,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw incompleteThreadCoverage(`page ${pageNumber} failed: ${detail}`);
      }

      if (!rawPage || typeof rawPage !== "object" || Array.isArray(rawPage)) {
        throw incompleteThreadCoverage(`page ${pageNumber} returned a malformed response`);
      }
      const page = rawPage as Record<string, unknown>;
      if (!Array.isArray(page.messages)) {
        throw incompleteThreadCoverage(`page ${pageNumber} returned a malformed messages collection`);
      }
      if (page.has_more !== undefined && typeof page.has_more !== "boolean") {
        throw incompleteThreadCoverage(`page ${pageNumber} returned malformed has_more metadata`);
      }
      if (
        page.response_metadata !== undefined
        && (
          page.response_metadata === null
          || typeof page.response_metadata !== "object"
          || Array.isArray(page.response_metadata)
        )
      ) {
        throw incompleteThreadCoverage(`page ${pageNumber} returned malformed cursor metadata`);
      }

      const responseMetadata = page.response_metadata as Record<string, unknown> | undefined;
      const rawNextCursor = responseMetadata?.next_cursor;
      if (
        rawNextCursor !== undefined
        && rawNextCursor !== null
        && typeof rawNextCursor !== "string"
      ) {
        throw incompleteThreadCoverage(`page ${pageNumber} returned a non-string cursor`);
      }
      if (
        typeof rawNextCursor === "string"
        && rawNextCursor !== ""
        && rawNextCursor.trim() !== rawNextCursor
      ) {
        throw incompleteThreadCoverage(`page ${pageNumber} returned a malformed cursor`);
      }
      const nextCursor = rawNextCursor === "" || rawNextCursor == null
        ? undefined
        : rawNextCursor;

      const newMessages: ExhaustiveThreadMessage[] = [];
      const pageMessageTimestamps = new Set<string>();
      for (const [messageIndex, message] of page.messages.entries()) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw incompleteThreadCoverage(
            `page ${pageNumber} message ${messageIndex + 1} is malformed`,
          );
        }
        const messageRecord = message as Record<string, unknown>;
        if (typeof messageRecord.ts !== "string" || !SLACK_TS_PATTERN.test(messageRecord.ts)) {
          throw incompleteThreadCoverage(
            `page ${pageNumber} message ${messageIndex + 1} has a malformed timestamp`,
          );
        }
        if (
          messageRecord.thread_ts !== undefined
          && (
            typeof messageRecord.thread_ts !== "string"
            || !SLACK_TS_PATTERN.test(messageRecord.thread_ts)
          )
        ) {
          throw incompleteThreadCoverage(
            `page ${pageNumber} message ${messageIndex + 1} has a malformed thread timestamp`,
          );
        }
        const validatedMessage = messageRecord as ExhaustiveThreadMessage;
        if (pageMessageTimestamps.has(validatedMessage.ts)) {
          throw incompleteThreadCoverage(
            `page ${pageNumber} contains duplicate message timestamp ${validatedMessage.ts}`,
          );
        }
        pageMessageTimestamps.add(validatedMessage.ts);
        if (!seenMessageTimestamps.has(validatedMessage.ts)) {
          newMessages.push(validatedMessage);
        }
      }

      if (nextCursor && (nextCursor === cursor || seenCursors.has(nextCursor))) {
        throw incompleteThreadCoverage(`page ${pageNumber} repeated pagination cursor ${nextCursor}`);
      }
      if (nextCursor && page.has_more === false) {
        throw incompleteThreadCoverage(
          `page ${pageNumber} returned a cursor while declaring has_more=false`,
        );
      }
      if (!nextCursor && page.has_more === true) {
        throw incompleteThreadCoverage(
          `page ${pageNumber} declared has_more=true without a next cursor`,
        );
      }
      if (messages.length + newMessages.length > maxMessages) {
        throw incompleteThreadCoverage(`maxMessages bound ${maxMessages} was exhausted`);
      }

      for (const message of newMessages) {
        seenMessageTimestamps.add(message.ts);
        messages.push(message);
      }

      if (!nextCursor) {
        return {
          ok: true,
          messages,
          has_more: false,
          response_metadata: { next_cursor: "" },
          complete: true,
          page_count: pageNumber,
        };
      }
      if (pageNumber === maxPages) {
        throw incompleteThreadCoverage(`maxPages bound ${maxPages} was exhausted`);
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw incompleteThreadCoverage(`maxPages bound ${maxPages} was exhausted`);
  }

  async getAllThreadReplies(
    channelId: string,
    threadTs: string,
    options: ExhaustiveMessageReadOptions = {},
  ): Promise<ExhaustiveMessageResult> {
    return this.getAllMessagePages(
      "Slack thread replies",
      options.cursor,
      options.maxPages,
      (cursor) => this.getThreadRepliesDirect(
        channelId,
        threadTs,
        options.limit,
        options.oldest,
        options.latest,
        cursor,
      ),
    );
  }

  private async getAllMessagePages(
    label: string,
    initialCursor: string | undefined,
    maxPages = DEFAULT_EXHAUSTIVE_MESSAGE_MAX_PAGES,
    loadPage: (cursor?: string) => Promise<SlackMessagePage>,
  ): Promise<ExhaustiveMessageResult> {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_EXHAUSTIVE_MESSAGE_PAGES) {
      throw new Error(`${label} maxPages must be an integer between 1 and ${MAX_EXHAUSTIVE_MESSAGE_PAGES}`);
    }

    const messages: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor = initialCursor;
    let lastPage: SlackMessagePage | undefined;

    if (cursor) {
      seenCursors.add(cursor);
    }

    for (let pagesFetched = 1; pagesFetched <= maxPages; pagesFetched += 1) {
      const page = await loadPage(cursor);
      if (!page || typeof page !== "object" || !Array.isArray(page.messages)) {
        throw new Error(`${label} page ${pagesFetched} returned malformed messages`);
      }

      lastPage = page;
      messages.push(...page.messages);

      const rawResponseMetadata = page.response_metadata;
      if (
        rawResponseMetadata != null
        && (typeof rawResponseMetadata !== "object" || Array.isArray(rawResponseMetadata))
      ) {
        throw new Error(`${label} page ${pagesFetched} returned malformed response metadata`);
      }
      if (page.has_more != null && typeof page.has_more !== "boolean") {
        throw new Error(`${label} page ${pagesFetched} returned malformed has_more metadata`);
      }
      const rawNextCursor = rawResponseMetadata?.next_cursor;
      if (rawNextCursor != null && typeof rawNextCursor !== "string") {
        throw new Error(`${label} page ${pagesFetched} returned a malformed next cursor`);
      }
      const nextCursor = typeof rawNextCursor === "string" && rawNextCursor.trim() !== ""
        ? rawNextCursor
        : undefined;
      const terminalByHasMore = page.has_more === false;
      const terminalByCursor = typeof rawNextCursor === "string" && rawNextCursor.trim() === "";
      const hasContinuation = page.has_more === true || nextCursor !== undefined;

      if (terminalByHasMore && nextCursor !== undefined) {
        throw new Error(`${label} page ${pagesFetched} returned contradictory pagination metadata`);
      }
      if (page.has_more === true && !nextCursor) {
        throw new Error(`${label} page ${pagesFetched} declared more pages without a next cursor`);
      }
      if ((terminalByHasMore || terminalByCursor) && !hasContinuation) {
        return {
          ...lastPage,
          messages,
          has_more: false,
          response_metadata: {
            ...lastPage.response_metadata,
            next_cursor: "",
          },
          pages_fetched: pagesFetched,
          complete: true,
        };
      }
      if (!hasContinuation) {
        throw new Error(
          `${label} page ${pagesFetched} did not provide explicit terminal or continuation metadata`,
        );
      }
      if (!nextCursor) {
        throw new Error(`${label} page ${pagesFetched} declared more pages without a next cursor`);
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`${label} page ${pagesFetched} repeated cursor ${nextCursor}`);
      }
      if (pagesFetched >= maxPages) {
        throw new Error(`${label} exceeded the ${maxPages}-page limit before pagination completed`);
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error(`${label} pagination ended unexpectedly`);
  }


  async postMessage(channelId: string, text: string): Promise<any> {
    const token = this.getToken();

    try {
      const response = await fetchWithRetry(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
            text: text,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.chat.postMessage",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found.`);
        }
        if (result.error === "not_in_channel") {
          throw new Error(`Not a member of channel ${channelId}.`);
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      cache.invalidatePattern(channelCachePattern("history", channelId));
      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async postMessageAsBot(channelId: string, text: string): Promise<any> {
    const token = this.getBotToken();
    const response = await fetchWithRetry(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: channelId,
          text: text,
        }),
      },
      { maxRetries: 3, timeoutMs: 30_000 },
      "Slack.chat.postMessage",
    );
    const result = await response.json();
    cache.invalidatePattern(channelCachePattern("history", channelId));
    return result;
  }

  async replyToThread(
    channelId: string,
    threadTs: string,
    text: string
  ): Promise<any> {
    const token = this.getToken();

    try {
      const response = await fetchWithRetry(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
            text: text,
            thread_ts: threadTs,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.chat.postMessage",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found.`);
        }
        if (result.error === "thread_not_found") {
          throw new Error(
            `Thread ${threadTs} not found in channel ${channelId}.`
          );
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      cache.invalidate(
        createCacheKey("thread", { channel: channelId, ts: threadTs })
      );
      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async replyToThreadAsBot(
    channelId: string,
    threadTs: string,
    text: string
  ): Promise<unknown> {
    const token = this.getBotToken();

    try {
      const response = await fetchWithRetry(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
            text: text,
            thread_ts: threadTs,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.chat.postMessage",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = (await response.json()) as { ok?: boolean; error?: string };

      if (!result.ok) {
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found.`);
        }
        if (result.error === "thread_not_found") {
          throw new Error(
            `Thread ${threadTs} not found in channel ${channelId}.`
          );
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      cache.invalidate(
        createCacheKey("thread", { channel: channelId, ts: threadTs })
      );
      return result;
    } catch (err) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async joinChannelAsBot(channelId: string): Promise<unknown> {
    const token = this.getBotToken();

    try {
      const response = await fetchWithRetry(
        "https://slack.com/api/conversations.join",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.conversations.join",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = (await response.json()) as { ok?: boolean; error?: string };

      if (!result.ok) {
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found.`);
        }
        if (result.error === "is_archived") {
          throw new Error(`Channel ${channelId} is archived.`);
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      cache.invalidatePattern(new RegExp("^channels"));
      return result;
    } catch (err) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async editMessageAsBot(
    channelId: string,
    timestamp: string,
    text: string,
    expectedTextSha256: string,
    threadTs?: string,
    lockOptions?: SlackEditLockOptions,
  ): Promise<unknown> {
    const botToken = this.getBotToken();
    const readToken = this.getToken();
    if (!/^[a-f0-9]{64}$/.test(expectedTextSha256)) {
      throw new Error("expectedTextSha256 must be a lowercase SHA-256 hex digest");
    }

    const lockedResult = await withSlackEditLock(channelId, timestamp, async () => {
      try {
        const authResponse = await fetchWithRetry(
        "https://slack.com/api/auth.test",
        {
          headers: {
            Authorization: `Bearer ${botToken}`,
          },
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.auth.test",
      );
      if (!authResponse.ok) {
        throw new Error(`Slack API HTTP error: ${authResponse.status}`);
      }

      const auth = (await authResponse.json()) as {
        ok?: boolean;
        error?: string;
        user_id?: string;
        bot_id?: string;
      };
      if (!auth.ok) {
        throw new Error(`Slack auth.test error: ${auth.error ?? "unknown_error"}`);
      }
      if (!auth.user_id || !auth.bot_id) {
        throw new Error("Slack auth.test did not return both user_id and bot_id; bot authorship cannot be proven");
      }

      const params = new URLSearchParams({
        channel: channelId,
        oldest: timestamp,
        latest: timestamp,
        inclusive: "true",
        limit: "1",
      });
      const readMethod = threadTs ? "conversations.replies" : "conversations.history";
      if (threadTs) {
        params.set("ts", threadTs);
      }
      const readResponse = await fetchWithRetry(
        `https://slack.com/api/${readMethod}?${params}`,
        {
          headers: {
            Authorization: `Bearer ${readToken}`,
          },
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        `Slack.${readMethod}`,
      );
      if (!readResponse.ok) {
        throw new Error(`Slack API HTTP error: ${readResponse.status}`);
      }

      const readResult = (await readResponse.json()) as {
        ok?: boolean;
        error?: string;
        messages?: Array<{
          ts?: string;
          text?: string;
          user?: string;
          bot_id?: string;
          blocks?: unknown;
        }>;
      };
      if (!readResult.ok) {
        throw new Error(`Slack ${readMethod} error: ${readResult.error ?? "unknown_error"}`);
      }
      const message = Array.isArray(readResult.messages)
        ? readResult.messages.find((candidate) => candidate?.ts === timestamp)
        : undefined;
      if (!message) {
        throw new Error(`Message ${timestamp} not found in channel ${channelId}; refusing bot edit`);
      }
      if (message.user !== auth.user_id || message.bot_id !== auth.bot_id) {
        throw new Error(
          `Message ${timestamp} authorship does not match the configured bot; refusing bot edit`,
        );
      }
      if (typeof message.text !== "string") {
        throw new Error(`Message ${timestamp} has no current text; freshness cannot be proven`);
      }
      if (message.blocks !== undefined && !Array.isArray(message.blocks)) {
        throw new Error(`Message ${timestamp} has malformed block metadata; refusing bot edit`);
      }
      if (Array.isArray(message.blocks) && message.blocks.length > 0) {
        throw new Error(
          `Message ${timestamp} contains Slack blocks; safe block reconstruction is unproven and the edit was refused`,
        );
      }
      if (slackMessageTextSha256(message.text) !== expectedTextSha256) {
        throw new Error(
          `Message ${timestamp} text changed since it was read; freshness check failed and the edit was refused`,
        );
      }

      const updateResponse = await fetchWithRetry(
        "https://slack.com/api/chat.update",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
            ts: timestamp,
            text,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.chat.update",
      );
      if (!updateResponse.ok) {
        throw new Error(`Slack API HTTP error: ${updateResponse.status}`);
      }

      const result = (await updateResponse.json()) as { ok?: boolean; error?: string };
      if (!result.ok) {
        if (result.error === "message_not_found") {
          throw new Error(`Message ${timestamp} not found in channel ${channelId}.`);
        }
        if (result.error === "cant_update_message") {
          throw new Error(`Slack refused to update message ${timestamp} as the configured bot.`);
        }
        if (result.error === "edit_window_closed") {
          throw new Error(`Slack's edit window is closed for message ${timestamp}.`);
        }
        if (result.error === "missing_scope") {
          throw new Error("Message editing requires chat:write scope on the bot token.");
        }
        throw new Error(`Slack API error: ${result.error ?? "unknown_error"}`);
      }

      try {
        cache.invalidatePattern(channelCachePattern("history", channelId));
        cache.invalidatePattern(channelCachePattern("thread", channelId));
        cache.invalidatePattern(/^search/);
        return result;
      } catch (cacheError) {
        const detail = cacheError instanceof Error ? cacheError.message : String(cacheError);
        return {
          ...result,
          do_not_retry: true,
          warning:
            "Slack accepted the message edit, but local cache invalidation failed. "
            + `Do not retry; re-read the message without cache. (${detail})`,
        };
      }
      } catch (err) {
        if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
          throw new Error("Slack API request timed out after 30 seconds.");
        }
        throw err;
      }
    }, lockOptions);

    if (lockedResult.cleanupWarning) {
      const value = lockedResult.value && typeof lockedResult.value === "object"
        ? lockedResult.value as Record<string, unknown>
        : { result: lockedResult.value };
      const priorWarning = typeof value.warning === "string" ? value.warning : undefined;
      return {
        ...value,
        lock_cleanup_failed: true,
        do_not_retry: true,
        warning: priorWarning
          ? `${priorWarning} ${lockedResult.cleanupWarning}`
          : lockedResult.cleanupWarning,
      };
    }
    return lockedResult.value;
  }


  async deleteMessage(channelId: string, timestamp: string): Promise<any> {
    const token = this.getToken();

    try {
      const response = await fetchWithRetry(
        "https://slack.com/api/chat.delete",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
            ts: timestamp,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.chat.delete",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found.`);
        }
        if (result.error === "message_not_found") {
          throw new Error(
            `Message ${timestamp} not found in channel ${channelId}.`
          );
        }
        if (result.error === "cant_delete_message") {
          throw new Error(
            `Cannot delete message ${timestamp}. You can only delete messages you posted.`
          );
        }
        if (result.error === "compliance_exports_prevent_deletion") {
          throw new Error(
            "Compliance exports prevent message deletion in this workspace."
          );
        }
        if (result.error === "not_in_channel") {
          throw new Error(`Not a member of channel ${channelId}.`);
        }
        if (result.error === "missing_scope") {
          throw new Error(
            "Message deletion requires chat:write scope. Update your Slack app OAuth permissions."
          );
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      cache.invalidatePattern(channelCachePattern("history", channelId));
      cache.invalidatePattern(channelCachePattern("thread", channelId));
      cache.invalidatePattern(/^search/);
      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }

  async deleteMessageAsBot(channelId: string, timestamp: string): Promise<any> {
    const token = this.getBotToken();

    try {
      const response = await fetchWithRetry(
        "https://slack.com/api/chat.delete",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
            ts: timestamp,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.chat.delete",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "channel_not_found") {
          throw new Error(`Channel ${channelId} not found.`);
        }
        if (result.error === "message_not_found") {
          throw new Error(
            `Message ${timestamp} not found in channel ${channelId}.`
          );
        }
        if (result.error === "cant_delete_message") {
          throw new Error(
            `Cannot delete message ${timestamp}. Bot can only delete messages it posted.`
          );
        }
        if (result.error === "compliance_exports_prevent_deletion") {
          throw new Error(
            "Compliance exports prevent message deletion in this workspace."
          );
        }
        if (result.error === "not_in_channel") {
          throw new Error(`Bot is not a member of channel ${channelId}.`);
        }
        if (result.error === "missing_scope") {
          throw new Error(
            "Message deletion requires chat:write scope on the bot token."
          );
        }
        if (result.error === "ratelimited") {
          const retryAfter = response.headers.get("Retry-After") || "unknown";
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      cache.invalidatePattern(channelCachePattern("history", channelId));
      cache.invalidatePattern(channelCachePattern("thread", channelId));
      cache.invalidatePattern(/^search/);
      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }


  async searchMessages(
    query: string,
    options?: { count?: number }
  ): Promise<any> {
    const cacheKey = createCacheKey("search", {
      query,
      count: options?.count,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const token = this.getToken();
        const params = new URLSearchParams();
        params.set("query", query);
        if (options?.count) {
          params.set("count", options.count.toString());
        }

        const response = await fetchWithRetry(
          `https://slack.com/api/search.messages?${params}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
          { maxRetries: 3, timeoutMs: 30_000 },
          "Slack.search.messages",
        );
        const result = await response.json();

        if (!result.ok) {
          if (result.error === "missing_scope") {
            throw new Error(
              "Search requires search:read scope. Update your Slack app OAuth permissions."
            );
          }
          if (result.error === "not_allowed_token_type") {
            throw new Error(
              "Search requires a user token (xoxp-), not a bot token."
            );
          }
          throw new Error(`Slack API error: ${result.error}`);
        }
        return result;
      },
      { ttl: TTL.FIVE_MINUTES }
    );
  }


  async addReaction(
    channelId: string,
    timestamp: string,
    reaction: string
  ): Promise<any> {
    const token = this.getToken();
    const response = await fetchWithRetry(
      "https://slack.com/api/reactions.add",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: channelId,
          timestamp: timestamp,
          name: reaction,
        }),
      },
      { maxRetries: 3, timeoutMs: 30_000 },
      "Slack.reactions.add",
    );
    return response.json();
  }


  async getUsers(options?: { limit?: number; cursor?: string }): Promise<any> {
    const cacheKey = createCacheKey("users", {
      limit: options?.limit,
      cursor: options?.cursor,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const token = this.getToken();
        const params = new URLSearchParams();
        if (options?.limit) {
          params.set("limit", options.limit.toString());
        }
        if (options?.cursor) {
          params.set("cursor", options.cursor);
        }

        const response = await fetchWithRetry(
          `https://slack.com/api/users.list?${params}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
          { maxRetries: 3, timeoutMs: 30_000 },
          "Slack.users.list",
        );
        return response.json();
      },
      { ttl: TTL.HOUR }
    );
  }

  async getUserProfile(userId: string): Promise<any> {
    const cacheKey = createCacheKey("user_profile", { id: userId });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const token = this.getToken();
        const response = await fetchWithRetry(
          `https://slack.com/api/users.info?user=${userId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
          { maxRetries: 3, timeoutMs: 30_000 },
          "Slack.users.info",
        );
        return response.json();
      },
      { ttl: TTL.FIFTEEN_MINUTES }
    );
  }

  async lookupUserByEmail(email: string): Promise<any> {
    const cacheKey = createCacheKey("user_lookup_email", { email });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const token = this.getBotToken();
        const params = new URLSearchParams({ email });
        const response = await fetchWithRetry(
          `https://slack.com/api/users.lookupByEmail?${params}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
          { maxRetries: 3, timeoutMs: 30_000 },
          "Slack.users.lookupByEmail",
        );
        return response.json();
      },
      { ttl: TTL.HOUR }
    );
  }


  async markRead(channelId: string, timestamp: string): Promise<any> {
    const token = this.getBotToken();

    try {
      const response = await fetchWithRetry(
        "https://slack.com/api/conversations.mark",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: channelId,
            ts: timestamp,
          }),
        },
        { maxRetries: 3, timeoutMs: 30_000 },
        "Slack.conversations.mark",
      );

      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === "missing_scope") {
          throw new Error(
            "Mark-read requires channels:write scope on the bot token."
          );
        }
        throw new Error(`Slack API error: ${result.error}`);
      }
      return result;
    } catch (err: any) {
      if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
        throw new Error("Slack API request timed out after 30 seconds.");
      }
      throw err;
    }
  }


  async getPermalink(channelId: string, messageTs: string): Promise<any> {
    const cacheKey = createCacheKey("permalink", {
      channel: channelId,
      ts: messageTs,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const token = this.getToken();
        const params = new URLSearchParams();
        params.set("channel", channelId);
        params.set("message_ts", messageTs);

        try {
          const response = await fetchWithRetry(
            `https://slack.com/api/chat.getPermalink?${params}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
            { maxRetries: 3, timeoutMs: 30_000 },
            "Slack.chat.getPermalink",
          );

          if (!response.ok) {
            throw new Error(`Slack API HTTP error: ${response.status}`);
          }

          const result = await response.json();

          if (!result.ok) {
            if (result.error === "channel_not_found") {
              throw new Error(`Channel ${channelId} not found or not accessible.`);
            }
            if (result.error === "message_not_found") {
              throw new Error(
                `Message ${messageTs} not found in channel ${channelId}.`
              );
            }
            if (result.error === "ratelimited") {
              const retryAfter = response.headers.get("Retry-After") || "unknown";
              throw new Error(
                `Rate limited by Slack API. Retry after ${retryAfter} seconds.`
              );
            }
            throw new Error(`Slack API error: ${result.error}`);
          }
          return result;
        } catch (err: any) {
          if (err instanceof Error && /(timed out|timeout|abort)/i.test(err.message)) {
            throw new Error("Slack API request timed out after 30 seconds.");
          }
          throw err;
        }
      },
      { ttl: TTL.FIFTEEN_MINUTES },
    );
  }
}

export default SlackMCPClient;
