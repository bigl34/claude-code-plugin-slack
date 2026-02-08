#!/usr/bin/env npx tsx
/**
 * Slack Manager CLI
 *
 * Zod-validated CLI for Slack workspace operations via MCP.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
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
      return client.listChannels({ limit });
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
      return client.getChannelHistory(channel, limit);
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
      return client.getThreadReplies(channel, thread);
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
      return client.getUsers({ limit });
    },
    "List workspace users"
  ),

  "get-user-profile": createCommand(
    z.object({
      user: z.string().min(1).describe("User ID"),
    }),
    async (args, client: SlackMCPClient) => {
      const { user } = args as { user: string };
      return client.getUserProfile(user);
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
      return client.searchMessages(query, { count: limit });
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
