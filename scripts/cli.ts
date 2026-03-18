#!/usr/bin/env npx tsx
/**
 * Slack Manager CLI
 *
 * Zod-validated CLI for Slack workspace operations via MCP.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes, wrapUntrustedField, buildSafeOutput } from "@local/cli-utils";
import { SlackMCPClient } from "./mcp-client.js";

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: SlackMCPClient) => {
      const tools = await client.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available MCP tools"
  ),

  // ==================== Channels ====================
  "list-channels": createCommand(
    z.object({
      limit: cliTypes.int(1, 1000).optional().describe("Max channels to return"),
    }),
    async (args, client: SlackMCPClient) => {
      const { limit } = args as { limit?: number };
      const result = await client.listChannels({ limit });

      const channels = (result?.channels || result || []);
      const wrappedChannels = (Array.isArray(channels) ? channels : []).map((ch: any) => ({
        metadata: {
          id: ch.id,
          num_members: ch.num_members,
          is_archived: ch.is_archived,
        },
        content: {
          name: wrapUntrustedField("name", ch.name, { maxChars: 200 }),
          topic: wrapUntrustedField("topic", ch.topic?.value || ch.topic, { maxChars: 500 }),
          purpose: wrapUntrustedField("purpose", ch.purpose?.value || ch.purpose, { maxChars: 500 }),
        },
      }));

      return buildSafeOutput(
        { command: "list-channels", count: wrappedChannels.length },
        { channels: wrappedChannels }
      );
    },
    "List public channels"
  ),

  "get-history": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID (e.g., C0123456789)"),
      limit: cliTypes.int(1, 1000).optional().describe("Max messages to return"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, limit } = args as { channel: string; limit?: number };
      const result = await client.getChannelHistory(channel, limit);

      const messages = (result?.messages || result || []);
      const wrappedMessages = (Array.isArray(messages) ? messages : []).map((msg: any) => ({
        metadata: {
          ts: msg.ts,
          type: msg.type,
          subtype: msg.subtype,
          user_id: msg.user,
        },
        content: {
          text: wrapUntrustedField("text", msg.text, { maxChars: 8000 }),
          username: wrapUntrustedField("username", msg.username || msg.user_profile?.display_name, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "get-history", channel, count: wrappedMessages.length },
        { messages: wrappedMessages }
      );
    },
    "Get channel message history"
  ),

  "get-thread": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      thread: z.string().min(1).describe("Thread timestamp"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, thread } = args as { channel: string; thread: string };
      const result = await client.getThreadReplies(channel, thread);

      const messages = (result?.messages || result || []);
      const wrappedMessages = (Array.isArray(messages) ? messages : []).map((msg: any) => ({
        metadata: {
          ts: msg.ts,
          type: msg.type,
          subtype: msg.subtype,
          user_id: msg.user,
          thread_ts: msg.thread_ts,
        },
        content: {
          text: wrapUntrustedField("text", msg.text, { maxChars: 8000 }),
          username: wrapUntrustedField("username", msg.username || msg.user_profile?.display_name, { maxChars: 200 }),
        },
      }));

      return buildSafeOutput(
        { command: "get-thread", channel, thread, count: wrappedMessages.length },
        { messages: wrappedMessages }
      );
    },
    "Get thread replies"
  ),

  // ==================== Messages ====================
  "post-message": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      text: z.string().min(1).describe("Message text"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, text } = args as { channel: string; text: string };
      return client.postMessage(channel, text);
    },
    "Post a message to a channel (as user)"
  ),

  "post-message-bot": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      text: z.string().min(1).describe("Message text"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, text } = args as { channel: string; text: string };
      return client.postMessageAsBot(channel, text);
    },
    "Post a message to a channel (as bot)"
  ),

  "reply-thread": createCommand(
    z.object({
      channel: z.string().min(1).describe("Channel ID"),
      thread: z.string().min(1).describe("Thread timestamp"),
      text: z.string().min(1).describe("Reply text"),
    }),
    async (args, client: SlackMCPClient) => {
      const { channel, thread, text } = args as { channel: string; thread: string; text: string };
      return client.replyToThread(channel, thread, text);
    },
    "Reply to a thread"
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
    "Add a reaction to a message"
  ),

  // ==================== Users ====================
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
    "List workspace users"
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
    "Get a user's profile"
  ),

  // ==================== Search ====================
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
          score: m.score,
          channel_id: m.channel?.id,
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
    "Search messages (requires user token)"
  ),

  // Pre-built cache commands
  ...cacheCommands<SlackMCPClient>(),
};

// Run CLI
runCli(commands, SlackMCPClient, {
  programName: "slack-cli",
  description: "Slack workspace operations via MCP",
});
