/**
 * Slack MCP Client
 *
 * Wrapper client for Slack workspace operations via MCP server and direct API.
 * Uses korotovsky/slack-mcp-server for channel/message operations, with direct
 * API calls for search, reactions, and user operations.
 *
 * Key features:
 * - Channel listing and history
 * - Message posting and thread replies
 * - Message search (requires user token with search:read)
 * - Reactions and user profile lookups
 * - Bot and user token support
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MCPConfig {
  mcpServer: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

// Initialize cache with namespace
const cache = new PluginCache({
  namespace: "slack-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class SlackMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private cacheDisabled: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /**
   * Disables caching for all subsequent requests.
   */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /**
   * Re-enables caching after it was disabled.
   */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /**
   * Returns cache statistics including hit/miss counts.
   */
  getCacheStats() {
    return cache.getStats();
  }

  /**
   * Clears all cached data.
   * @returns Number of cache entries cleared
   */
  clearCache(): number {
    return cache.clear();
  }

  /**
   * Invalidates a specific cache entry by key.
   */
  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  // ============================================
  // TOKEN MANAGEMENT (Private)
  // ============================================

  // Get token for direct API calls (reactions, users, etc.)
  private getToken(): string {
    const token = this.config.mcpServer.env?.SLACK_MCP_XOXP_TOKEN
      || this.config.mcpServer.env?.SLACK_MCP_XOXB_TOKEN;

    if (!token) {
      throw new Error('No Slack token configured');
    }
    return token;
  }

  // Get bot token specifically (for posting as bot, not user)
  private getBotToken(): string {
    const token = this.config.mcpServer.env?.SLACK_MCP_XOXB_TOKEN;

    if (!token) {
      throw new Error('No Slack bot token (xoxb) configured');
    }
    return token;
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  /**
   * Establishes connection to the MCP server.
   * Called automatically by other methods when needed.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    this.transport = new StdioClientTransport({
      command: this.config.mcpServer.command,
      args: this.config.mcpServer.args,
      env: env as Record<string, string>,
    });

    this.client = new Client(
      { name: "slack-cli", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;
    // Note: Removed fixed 5-second startup delay - using progressive retry instead
    // The callTool method handles "cache not ready" errors with exponential backoff
  }

  /**
   * Disconnects from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  // ============================================
  // MCP TOOLS
  // ============================================

  /**
   * Lists available MCP tools.
   * @returns Array of tool definitions
   */
  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  /**
   * Calls an MCP tool with arguments.
   *
   * Includes retry logic for "cache not ready" errors during MCP server startup.
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @param retries - Max retries (default: 6)
   * @param attempt - Current attempt (used internally)
   * @returns Parsed tool response
   * @throws {Error} If tool call fails after retries
   */
  async callTool(name: string, args: Record<string, any>, retries = 6, attempt = 0): Promise<any> {
    await this.connect();

    const result = await this.client!.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;

    if (result.isError) {
      const errorContent = content.find((c) => c.type === "text");
      const errorMsg = errorContent?.text || "Tool call failed";

      // Retry if server cache not ready (korotovsky/slack-mcp-server startup issue)
      // Uses exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s (max ~31.5s total)
      if (errorMsg.includes("cache is not ready") && retries > 0) {
        const delay = Math.min(500 * Math.pow(2, attempt), 16000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.callTool(name, args, retries - 1, attempt + 1);
      }

      throw new Error(errorMsg);
    }

    const textContent = content.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return content;
  }

  // ============================================
  // CHANNEL OPERATIONS
  // ============================================

  /**
   * Lists workspace channels via direct Slack API.
   * Bypasses MCP server to avoid cold start cache issues.
   *
   * @param options - Query options
   * @param options.limit - Max channels per page (default 100, max 1000)
   * @param options.cursor - Pagination cursor
   * @param options.types - Channel types (default: "public_channel,private_channel")
   * @returns Slack API response with channels array and pagination metadata
   *
   * @throws {Error} If token is missing or invalid
   * @throws {Error} If rate limited (includes Retry-After header)
   */
  private async listChannelsDirect(options?: {
    limit?: number;
    cursor?: string;
    types?: string;
  }): Promise<any> {
    const token = this.getToken();
    const params = new URLSearchParams();

    params.set('types', options?.types || 'public_channel,private_channel');
    params.set('exclude_archived', 'true');

    if (options?.limit) params.set('limit', Math.min(options.limit, 1000).toString());
    if (options?.cursor) params.set('cursor', options.cursor);

    // 30s timeout to handle network issues (common in WSL2 environment)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`https://slack.com/api/conversations.list?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      // HTTP status check for defensive coding
      if (!response.ok) {
        throw new Error(`Slack API HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.ok) {
        if (result.error === 'missing_scope') {
          throw new Error('Channel listing requires channels:read scope. Update your Slack app OAuth permissions.');
        }
        if (result.error === 'not_allowed_token_type') {
          throw new Error('Channel listing requires a user token (xoxp-) or bot token (xoxb-).');
        }
        if (result.error === 'ratelimited') {
          const retryAfter = response.headers.get('Retry-After') || 'unknown';
          throw new Error(`Rate limited by Slack API. Retry after ${retryAfter} seconds.`);
        }
        throw new Error(`Slack API error: ${result.error}`);
      }

      return result;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Slack API request timed out after 30 seconds.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Lists workspace channels (public and private).
   *
   * Uses direct Slack API (bypasses MCP for reliability).
   *
   * @param options - Query options
   * @param options.limit - Max channels to return
   * @param options.cursor - Pagination cursor
   * @returns Channel list with pagination info
   *
   * @cached TTL: 15 minutes
   */
  async listChannels(options?: { limit?: number; cursor?: string }): Promise<any> {
    const cacheKey = createCacheKey("channels", {
      limit: options?.limit,
      cursor: options?.cursor,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => this.listChannelsDirect(options),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets message history for a channel.
   *
   * @param channelId - Slack channel ID (e.g., "C0123456")
   * @param limit - Max messages to return
   * @returns Messages array with timestamps and content
   *
   * @cached TTL: 5 minutes
   */
  async getChannelHistory(channelId: string, limit?: number): Promise<any> {
    const cacheKey = createCacheKey("history", { channel: channelId, limit });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = { channel_id: channelId };
        if (limit) args.limit = limit;
        return this.callTool("conversations_history", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets replies in a message thread.
   *
   * @param channelId - Slack channel ID
   * @param threadTs - Thread parent message timestamp
   * @returns Thread messages including parent
   *
   * @cached TTL: 5 minutes
   */
  async getThreadReplies(channelId: string, threadTs: string): Promise<any> {
    const cacheKey = createCacheKey("thread", { channel: channelId, ts: threadTs });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("conversations_replies", {
        channel_id: channelId,
        thread_ts: threadTs,
      }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // MESSAGE OPERATIONS (WRITE)
  // ============================================

  /**
   * Posts a message to a channel (as user).
   *
   * @param channelId - Slack channel ID
   * @param text - Message text
   * @returns Posted message details
   *
   * @invalidates history/{channelId}
   */
  async postMessage(channelId: string, text: string): Promise<any> {
    const result = await this.callTool("conversations_add_message", {
      channel_id: channelId,
      payload: text,
    });
    // Invalidate channel history cache
    cache.invalidatePattern(new RegExp(`^history.*channel=${channelId}`));
    return result;
  }

  /**
   * Posts a message to a channel as the bot.
   *
   * Uses the bot token (xoxb-) directly, bypassing MCP server.
   *
   * @param channelId - Slack channel ID
   * @param text - Message text
   * @returns Posted message details
   *
   * @invalidates history/{channelId}
   */
  async postMessageAsBot(channelId: string, text: string): Promise<any> {
    const token = this.getBotToken();
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: channelId,
        text: text,
      }),
    });
    const result = await response.json();
    // Invalidate channel history cache
    cache.invalidatePattern(new RegExp(`^history.*channel=${channelId}`));
    return result;
  }

  /**
   * Replies to a message thread.
   *
   * @param channelId - Slack channel ID
   * @param threadTs - Thread parent message timestamp
   * @param text - Reply text
   * @returns Posted reply details
   *
   * @invalidates thread/{channelId}/{threadTs}
   */
  async replyToThread(channelId: string, threadTs: string, text: string): Promise<any> {
    const result = await this.callTool("conversations_add_message", {
      channel_id: channelId,
      thread_ts: threadTs,
      payload: text,
    });
    // Invalidate thread cache
    cache.invalidate(createCacheKey("thread", { channel: channelId, ts: threadTs }));
    return result;
  }

  // ============================================
  // SEARCH OPERATIONS
  // ============================================

  /**
   * Searches messages across the workspace.
   *
   * Uses direct Slack API (bypasses MCP for reliability).
   * Requires user token (xoxp-) with search:read scope.
   *
   * @param query - Search query (Slack search syntax)
   * @param options - Search options
   * @param options.count - Max results to return
   * @returns Search results with messages and metadata
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * await client.searchMessages("from:@user in:#general");
   */
  async searchMessages(query: string, options?: { count?: number }): Promise<any> {
    const cacheKey = createCacheKey("search", { query, count: options?.count });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const token = this.getToken();
        const params = new URLSearchParams();
        params.set('query', query);
        if (options?.count) params.set('count', options.count.toString());

        const response = await fetch(`https://slack.com/api/search.messages?${params}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
        const result = await response.json();

        if (!result.ok) {
          if (result.error === 'missing_scope') {
            throw new Error('Search requires search:read scope. Update your Slack app OAuth permissions.');
          }
          if (result.error === 'not_allowed_token_type') {
            throw new Error('Search requires a user token (xoxp-), not a bot token.');
          }
          throw new Error(`Slack API error: ${result.error}`);
        }
        return result;
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // REACTION OPERATIONS (WRITE)
  // ============================================

  /**
   * Adds a reaction emoji to a message.
   *
   * Uses direct Slack API (not available in MCP server).
   *
   * @param channelId - Slack channel ID
   * @param timestamp - Message timestamp
   * @param reaction - Emoji name without colons (e.g., "thumbsup")
   * @returns API response
   */
  async addReaction(channelId: string, timestamp: string, reaction: string): Promise<any> {
    const token = this.getToken();
    const response = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: channelId,
        timestamp: timestamp,
        emoji: reaction,
      }),
    });
    return response.json();
  }

  // ============================================
  // USER OPERATIONS
  // ============================================

  /**
   * Lists workspace users.
   *
   * Uses direct Slack API (not available in MCP server).
   *
   * @param options - Query options
   * @param options.limit - Max users to return
   * @param options.cursor - Pagination cursor
   * @returns User list with profiles
   *
   * @cached TTL: 1 hour
   */
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
        if (options?.limit) params.set('limit', options.limit.toString());
        if (options?.cursor) params.set('cursor', options.cursor);

        const response = await fetch(`https://slack.com/api/users.list?${params}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
        return response.json();
      },
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets a user's profile by ID.
   *
   * @param userId - Slack user ID (e.g., "U0123456")
   * @returns User profile with name, email, avatar, etc.
   *
   * @cached TTL: 15 minutes
   */
  async getUserProfile(userId: string): Promise<any> {
    const cacheKey = createCacheKey("user_profile", { id: userId });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const token = this.getToken();
        const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
        return response.json();
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }
}

export default SlackMCPClient;
