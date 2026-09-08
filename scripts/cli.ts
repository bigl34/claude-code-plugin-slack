#!/usr/bin/env npx tsx

import { readFileSync } from "node:fs";
import { z, createCommand, runCli, cacheCommands, cliTypes, wrapUntrustedField, buildSafeOutput } from "@local/cli-utils";
import { SlackMCPClient, slackMessageTextSha256 } from "./mcp-client.js";

function resolveMessageText(args: { text?: string; textFile?: string }): string {
  const hasInlineText = typeof args.text === "string";
  const hasTextFile = typeof args.textFile === "string";

  if (hasInlineText && hasTextFile) {
    throw new Error("Provide either --text or --text-file, not both");
  }
  if (!hasInlineText && !hasTextFile) {
    throw new Error("Provide a message body via --text or --text-file");
  }

  if (hasInlineText) {
    return args.text as string;
  }

  const filePath = args.textFile as string;
  let fileContents: string;
  try {
    fileContents = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Could not read --text-file '${filePath}': ${(err as Error).message}`);
  }
  if (fileContents.trim().length === 0) {
    throw new Error(`--text-file '${filePath}' is empty`);
  }
  return fileContents;
}

function summarizeFiles(files: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(files)) {
    return [];
  }
  return files.map((file: any) => ({
    id: file.id,
    name: file.name,
    filetype: file.filetype,
    permalink: file.permalink,
  }));
}

function wrapSlackMessage(msg: any): Record<string, unknown> {
  const metadata: Record<string, any> = {
    ts: msg.ts,
    type: msg.type,
    subtype: msg.subtype,
    user_id: msg.user,
    thread_ts: msg.thread_ts,
    bot_id: msg.bot_id,
    app_id: msg.app_id,
  };
  if (typeof msg.text === "string") {
    metadata.text_sha256 = slackMessageTextSha256(msg.text);
  }
  const fileSummaries = summarizeFiles(msg.files);
  if (fileSummaries.length > 0) {
    metadata.files = fileSummaries;
  }
  const attachmentsCount = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
  if (attachmentsCount > 0) {
    metadata.attachments_count = attachmentsCount;
  }
  const blocksCount = Array.isArray(msg.blocks) ? msg.blocks.length : 0;
  if (blocksCount > 0) {
    metadata.blocks_count = blocksCount;
  }
  if (typeof msg.reply_count === "number") {
    metadata.reply_count = msg.reply_count;
  }
  if (msg.edited) {
    metadata.edited = msg.edited;
  }
  if (Array.isArray(msg.reactions)) {
    metadata.reactions = msg.reactions;
  }
  return {
    metadata,
    content: {
      text: wrapUntrustedField("text", msg.text, { maxChars: 8000 }),
      username: wrapUntrustedField("username", msg.username || msg.user_profile?.display_name, { maxChars: 200 }),
    },
  };
}

const commands = {
  "list-channels": createCommand(
    z.object({
      limit: cliTypes.int(1, 1000).optional().describe("Max channels to return"),
      cursor: z.string().min(1).optional().describe("Slack pagination cursor from the previous response"),
      includePrivate: z.boolean().optional().describe("Also include private channels you're a member of"),
      includeArchived: cliTypes.bool().optional().describe("Include archived channels"),
    }),
    async (args, client: SlackMCPClient) => {
      const { limit, cursor, includePrivate, includeArchived } = args as {
        limit?: number;
        cursor?: string;
        includePrivate?: boolean;
        includeArchived?: boolean;
      };
      const result = await client.listChannels({ limit, cursor, includePrivate, includeArchived });

      const channels = (result?.channels || result || []);
      const wrappedChannels = (Array.isArray(channels) ? channels : []).map((ch: any) => ({
        metadata: {
          id: ch.id,
          num_members: ch.num_members,
          is_archived: ch.is_archived,
          is_private: ch.is_private,
          is_member: ch.is_member,
        },
        content: {
          name: wrapUntrustedField("name", ch.name, { maxChars: 200 }),
          topic: wrapUntrustedField("topic", ch.topic?.value || ch.topic, { maxChars: 500 }),
          purpose: wrapUntrustedField("purpose", ch.purpose?.value || ch.purpose, { maxChars: 500 }),
        },
      }));

      const nextCursor = result?.response_metadata?.next_cursor;
      const hasMore = result?.has_more;

      return buildSafeOutput(
        { command: "list-channels", count: wrappedChannels.length, cursor: nextCursor, has_more: hasMore },
        { channels: wrappedChannels }
      );
    },
    "List public channels (use --include-private to also include private channels you're a member of)",
    { sideEffect: "read" }
  ),

  "get-history": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID (e.g., C0123456789)"),
      limit: cliTypes.int(1, 1000).optional().describe("Max messages to return per page"),
      oldest: z.string().min(1).optional().describe("Slack ts — return messages newer than this timestamp"),
      latest: z.string().min(1).optional().describe("Slack ts — return messages older than this timestamp"),
      cursor: z.string().min(1).optional().describe("Slack pagination cursor from the previous response"),
      allPages: cliTypes.bool().optional().describe("Read every remaining page; fails instead of returning partial results"),
      maxPages: cliTypes.int(1, 100).optional().describe("Hard page cap for --all-pages (default: 20)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, limit, oldest, latest, cursor, allPages, maxPages } = args as {
        channel: string;
        limit?: number;
        oldest?: string;
        latest?: string;
        cursor?: string;
        allPages?: boolean;
        maxPages?: number;
      };
      if (maxPages !== undefined && allPages !== true) {
        throw new Error("--max-pages requires --all-pages");
      }
      const result = allPages === true
        ? await client.getAllChannelHistory(channel, { limit, oldest, latest, cursor, maxPages })
        : await client.getChannelHistory(channel, limit, oldest, latest, cursor);

      const messages = (result?.messages || result || []);
      const wrappedMessages = (Array.isArray(messages) ? messages : []).map((msg: any) => wrapSlackMessage(msg));

      const nextCursor = result?.response_metadata?.next_cursor;
      const hasNextCursor = typeof nextCursor === "string" && nextCursor.trim().length > 0;
      const hasMore = result?.has_more === true || hasNextCursor;
      const paginationShapeValid =
        (nextCursor === undefined || typeof nextCursor === "string")
        && (result?.has_more === undefined || typeof result?.has_more === "boolean");
      const explicitTerminal =
        result?.has_more === false
        || (typeof nextCursor === "string" && nextCursor.trim().length === 0);
      const contradictory = result?.has_more === false && hasNextCursor;
      const complete = result?.complete === true
        || (paginationShapeValid && explicitTerminal && !hasMore && !contradictory);
      const pagesFetched = result?.pages_fetched ?? 1;

      return buildSafeOutput(
        {
          command: "get-history",
          channel,
          count: wrappedMessages.length,
          cursor: nextCursor,
          has_more: hasMore,
          pages_fetched: pagesFetched,
          complete,
        },
        { messages: wrappedMessages }
      );
    },
    "Get channel message history",
    { sideEffect: "read" }
  ),

  "get-thread": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      thread: z.string().min(1).describe("Thread timestamp"),
      limit: cliTypes.int(1, 1000).optional().describe("Max replies to return per page"),
      oldest: z.string().min(1).optional().describe("Slack ts — return replies newer than this timestamp"),
      latest: z.string().min(1).optional().describe("Slack ts — return replies older than this timestamp"),
      cursor: z.string().min(1).optional().describe("Slack pagination cursor from the previous response"),
      allPages: cliTypes.bool().optional().describe("Read every remaining page; fails instead of returning partial results"),
      maxPages: cliTypes.int(1, 100).optional().describe("Hard page cap for --all-pages (default: 20)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, thread, limit, oldest, latest, cursor, allPages, maxPages } = args as {
        channel: string;
        thread: string;
        limit?: number;
        oldest?: string;
        latest?: string;
        cursor?: string;
        allPages?: boolean;
        maxPages?: number;
      };
      if (maxPages !== undefined && allPages !== true) {
        throw new Error("--max-pages requires --all-pages");
      }
      const result = allPages === true
        ? await client.getAllThreadReplies(channel, thread, { limit, oldest, latest, cursor, maxPages })
        : await client.getThreadReplies(channel, thread, limit, oldest, latest, cursor);

      const messages = (result?.messages || result || []);
      const wrappedMessages = (Array.isArray(messages) ? messages : []).map((msg: any) => wrapSlackMessage(msg));

      const nextCursor = result?.response_metadata?.next_cursor;
      const hasNextCursor = typeof nextCursor === "string" && nextCursor.trim().length > 0;
      const hasMore = result?.has_more === true || hasNextCursor;
      const paginationShapeValid =
        (nextCursor === undefined || typeof nextCursor === "string")
        && (result?.has_more === undefined || typeof result?.has_more === "boolean");
      const explicitTerminal =
        result?.has_more === false
        || (typeof nextCursor === "string" && nextCursor.trim().length === 0);
      const contradictory = result?.has_more === false && hasNextCursor;
      const complete = result?.complete === true
        || (paginationShapeValid && explicitTerminal && !hasMore && !contradictory);
      const pagesFetched = result?.pages_fetched ?? 1;

      return buildSafeOutput(
        {
          command: "get-thread",
          channel,
          thread,
          count: wrappedMessages.length,
          cursor: nextCursor,
          has_more: hasMore,
          pages_fetched: pagesFetched,
          complete,
        },
        { messages: wrappedMessages }
      );
    },
    "Get thread replies",
    { sideEffect: "read" }
  ),

  "get-thread-all": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      thread: z.string().min(1).describe("Thread timestamp"),
      limit: cliTypes.int(1, 1000).optional().describe("Slack replies requested per page"),
      oldest: z.string().min(1).optional().describe("Slack ts — return replies newer than this timestamp"),
      latest: z.string().min(1).optional().describe("Slack ts — return replies older than this timestamp"),
      maxPages: cliTypes.int(1, 1000).optional().describe("Hard page bound (default 100)"),
      maxMessages: cliTypes.int(1, 100000).optional().describe("Hard aggregate-message bound (default 10000)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, thread, limit, oldest, latest, maxPages, maxMessages } = args as {
        channel: string;
        thread: string;
        limit?: number;
        oldest?: string;
        latest?: string;
        maxPages?: number;
        maxMessages?: number;
      };
      const result = await client.getThreadRepliesExhaustive(channel, thread, {
        limit,
        oldest,
        latest,
        maxPages,
        maxMessages,
      });
      const wrappedMessages = result.messages.map((message) => wrapSlackMessage(message));

      return buildSafeOutput(
        {
          command: "get-thread-all",
          channel,
          thread,
          count: wrappedMessages.length,
          complete: result.complete,
          pages: result.page_count,
          cursor: result.response_metadata.next_cursor,
          has_more: result.has_more,
        },
        { messages: wrappedMessages },
      );
    },
    "Exhaust all thread-reply pages for reconciliation; exits non-zero rather than returning partial coverage",
    { sideEffect: "read" },
  ),

  "get-permalink": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID (e.g., C0123456789)"),
      messageTs: z.string().min(1).describe("Slack message ts (e.g., 1708123456.000200)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, messageTs } = args as { channel: string; messageTs: string };
      const result = await client.getPermalink(channel, messageTs);

      return buildSafeOutput(
        { command: "get-permalink", channel, message_ts: messageTs, permalink: result?.permalink },
        {}
      );
    },
    "Resolve the Slack archive URL for a (channel, message ts) pair",
    { sideEffect: "read" }
  ),

  "post-message": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      text: z.string().min(1).optional().describe("Message text (mutually exclusive with --text-file)"),
      textFile: z.string().min(1).optional().describe("Path to a UTF-8 file read verbatim as the message body — survives backticks/code spans/quotes (mutually exclusive with --text)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel } = args as { channel: string };
      const text = resolveMessageText(args as { text?: string; textFile?: string });
      return client.postMessage(channel, text);
    },
    "Post a message to a channel (as user)",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "post-message-bot": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      text: z.string().min(1).optional().describe("Message text (mutually exclusive with --text-file)"),
      textFile: z.string().min(1).optional().describe("Path to a UTF-8 file read verbatim as the message body — survives backticks/code spans/quotes (mutually exclusive with --text)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel } = args as { channel: string };
      const text = resolveMessageText(args as { text?: string; textFile?: string });
      return client.postMessageAsBot(channel, text);
    },
    "Post a message to a channel (as bot)",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "reply-thread": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      thread: z.string().min(1).describe("Thread timestamp"),
      text: z.string().min(1).optional().describe("Reply text (mutually exclusive with --text-file)"),
      textFile: z.string().min(1).optional().describe("Path to a UTF-8 file read verbatim as the reply body — survives backticks/code spans/quotes (mutually exclusive with --text)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, thread } = args as { channel: string; thread: string };
      const text = resolveMessageText(args as { text?: string; textFile?: string });
      return client.replyToThread(channel, thread, text);
    },
    "Reply to a thread",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "reply-thread-bot": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      thread: z.string().min(1).describe("Thread timestamp"),
      text: z.string().min(1).optional().describe("Reply text (mutually exclusive with --text-file)"),
      textFile: z.string().min(1).optional().describe("Path to a UTF-8 file read verbatim as the reply body — survives backticks/code spans/quotes (mutually exclusive with --text)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, thread } = args as { channel: string; thread: string };
      const text = resolveMessageText(args as { text?: string; textFile?: string });
      return client.replyToThreadAsBot(channel, thread, text);
    },
    "Reply to a thread (as bot)",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "edit-message-bot": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      timestamp: z.string().min(1).describe("Message timestamp"),
      thread: z.string().min(1).optional().describe("Parent thread timestamp when editing a reply"),
      expectedTextSha256: z.string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("SHA-256 from the latest get-history/get-thread metadata.text_sha256"),
      text: z.string().min(1).optional().describe("Replacement text (mutually exclusive with --text-file)"),
      textFile: z.string().min(1).optional().describe("Path to a UTF-8 replacement body (mutually exclusive with --text)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, timestamp, thread, expectedTextSha256 } = args as {
        channel: string;
        timestamp: string;
        thread?: string;
        expectedTextSha256: string;
      };
      const text = resolveMessageText(args as { text?: string; textFile?: string });
      return client.editMessageAsBot(channel, timestamp, text, expectedTextSha256, thread);
    },
    "Edit a bot-authored message after live authorship and text-freshness checks",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "delete-message": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      timestamp: z.string().min(1).describe("Message timestamp"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, timestamp } = args as { channel: string; timestamp: string };
      return client.deleteMessage(channel, timestamp);
    },
    "Delete a message (as user)",
    { sideEffect: "destructive", requiresConfirmation: true }
  ),

  "delete-message-bot": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      timestamp: z.string().min(1).describe("Message timestamp"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, timestamp } = args as { channel: string; timestamp: string };
      return client.deleteMessageAsBot(channel, timestamp);
    },
    "Delete a bot message",
    { sideEffect: "destructive", requiresConfirmation: true }
  ),

  "join-channel": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel } = args as { channel: string };
      return client.joinChannelAsBot(channel);
    },
    "Join a public channel (as bot)",
    { sideEffect: "write" }
  ),

  "add-reaction": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      timestamp: z.string().min(1).describe("Message timestamp"),
      reaction: z.string().min(1).describe("Reaction emoji name (without colons)"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, timestamp, reaction } = args as {
        channel: string; timestamp: string; reaction: string;
      };
      return client.addReaction(channel, timestamp, reaction);
    },
    "Add a reaction to a message",
    { sideEffect: "write" }
  ),

  "get-users": createCommand(
    z.object({
      limit: cliTypes.int(1, 1000).optional().describe("Max users to return"),
    }),
    async (args, client: SlackMCPClient) => {
      const { limit } = args as { limit?: number };
      const result = await client.getUsers({ limit });

      const members = (result?.members || result || []);
      const wrappedUsers = (Array.isArray(members) ? members : []).map((u: any) => ({
        metadata: {
          id: u.id,
          is_bot: u.is_bot,
          is_admin: u.is_admin,
          deleted: u.deleted,
        },
        content: {
          real_name: wrapUntrustedField("real_name", u.real_name || u.profile?.real_name, { maxChars: 200 }),
          display_name: wrapUntrustedField("display_name", u.profile?.display_name, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "get-users", count: wrappedUsers.length },
        { users: wrappedUsers }
      );
    },
    "List workspace users",
    { sideEffect: "read" }
  ),

  "get-user-profile": createCommand(
    z.object({
      user: z.string().min(1).describe("User ID"),
    }),
    async (args, client: SlackMCPClient) => {
      const { user } = args as { user: string };
      const result = await client.getUserProfile(user);

      const profile = result?.profile || result || {};
      return buildSafeOutput(
        { command: "get-user-profile", user_id: user },
        {
          real_name: wrapUntrustedField("real_name", profile.real_name, { maxChars: 200 }),
          display_name: wrapUntrustedField("display_name", profile.display_name, { maxChars: 200 }),
          status_text: wrapUntrustedField("status_text", profile.status_text, { maxChars: 500 }),
          title: wrapUntrustedField("title", profile.title, { maxChars: 200 }),
        }
      );
    },
    "Get a user's profile",
    { sideEffect: "read" }
  ),

  "lookup-by-email": createCommand(
    z.object({
      email: z.string().email().describe("Email address"),
    }),
    async (args, client: SlackMCPClient) => {
      const { email } = args as { email: string };
      const result = await client.lookupUserByEmail(email);
      const user = result?.user || result || {};
      const profile = user.profile || {};

      return buildSafeOutput(
        {
          command: "lookup-by-email",
          email,
          user_id: user.id,
          team_id: user.team_id,
          deleted: user.deleted,
          is_bot: user.is_bot,
        },
        {
          real_name: wrapUntrustedField("real_name", user.real_name || profile.real_name, { maxChars: 200 }),
          display_name: wrapUntrustedField("display_name", profile.display_name, { maxChars: 200 }),
          title: wrapUntrustedField("title", profile.title, { maxChars: 200 }),
          matched_email: wrapUntrustedField("matched_email", profile.email, { maxChars: 300 }),
        }
      );
    },
    "Look up a Slack user ID by email using the bot token",
    { sideEffect: "read" }
  ),

  "search-messages": createCommand(
    z.object({
      query: z.string().min(1).describe("Search query"),
      limit: cliTypes.int(1, 100).optional().describe("Max results"),
    }),
    async (args, client: SlackMCPClient) => {
      const { query, limit } = args as { query: string; limit?: number };
      const result = await client.searchMessages(query, { count: limit });

      const matches = (result?.messages?.matches || result?.matches || result || []);
      const wrappedMatches = (Array.isArray(matches) ? matches : []).map((m: any) => ({
        metadata: {
          ts: m.ts,
          thread_ts: m.thread_ts,
          score: m.score,
          channel_id: m.channel?.id,
          user_id: m.user,
          permalink: m.permalink,
          is_im: m.channel?.is_im,
          is_mpim: m.channel?.is_mpim,
          subtype: m.subtype,
          bot_id: m.bot_id,
          app_id: m.app_id,
        },
        content: {
          text: wrapUntrustedField("text", m.text, { maxChars: 8000 }),
          username: wrapUntrustedField("username", m.username, { maxChars: 200 }),
          channel_name: wrapUntrustedField("channel_name", m.channel?.name, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "search-messages", query, count: wrappedMatches.length },
        { matches: wrappedMatches }
      );
    },
    "Search messages (requires user token)",
    { sideEffect: "read" }
  ),

  "mark-read": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      timestamp: z.string().min(1).describe("Message timestamp to mark as read up to"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, timestamp } = args as { channel: string; timestamp: string };
      const result = await client.markRead(channel, timestamp);
      return buildSafeOutput(
        { command: "mark-read", channel, timestamp },
        result
      );
    },
    "Mark channel as read up to timestamp (requires SLACK_MCP_MARK_TOOL=true)",
    { sideEffect: "write" }
  ),

  ...cacheCommands<SlackMCPClient>(),
};

runCli(commands, SlackMCPClient, {
  programName: "slack-cli",
  description: "Slack workspace operations via MCP",
});

