<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-slack

Dedicated agent for Slack workspace operations with isolated MCP access

![Version](https://img.shields.io/badge/version-1.3.0-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Channel
- **list-channels** — List public channels
- **get-history** — Get channel messages
- **get-thread** — Get thread replies
- Message
- **post-message** — Post to channel (as user)
- **post-message-bot** — Post to channel (as bot)
- **reply-thread** — Reply to thread
- **add-reaction** — Add reaction
- User
- **get-users** — List workspace users
- **get-user-profile** — Get user profile
- Search
- **search-messages** — Search workspace messages

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-slack.git
cd claude-code-plugin-slack
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js list-channels
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```
4. Ensure the MCP server binary is available on your system (see the service's documentation)

## Available Commands

### Channel Commands

| Command         | Description          | Options                                 |
| --------------- | -------------------- | --------------------------------------- |
| `list-channels` | List public channels | `--limit`                               |
| `get-history`   | Get channel messages | `--channel` (required), `--limit`       |
| `get-thread`    | Get thread replies   | `--channel`, `--thread` (both required) |

### Message Commands

| Command            | Description               | Options                                                 |
| ------------------ | ------------------------- | ------------------------------------------------------- |
| `post-message`     | Post to channel (as user) | `--channel`, `--text` (both required)                   |
| `post-message-bot` | Post to channel (as bot)  | `--channel`, `--text` (both required)                   |
| `reply-thread`     | Reply to thread           | `--channel`, `--thread`, `--text` (all required)        |
| `add-reaction`     | Add reaction              | `--channel`, `--timestamp`, `--reaction` (all required) |

### User Commands

| Command            | Description          | Options             |
| ------------------ | -------------------- | ------------------- |
| `get-users`        | List workspace users | `--limit`           |
| `get-user-profile` | Get user profile     | `--user` (required) |

### Search Commands

| Command           | Description               | Options                         |
| ----------------- | ------------------------- | ------------------------------- |
| `search-messages` | Search workspace messages | `--query` (required), `--limit` |

## Usage Examples

```bash
# List channels
node $HOME/node scripts/dist/cli.js list-channels --limit 20

# Get recent messages from #orders
node $HOME/node scripts/dist/cli.js get-history --channel C0123456789 --limit 10

# Post a message
node $HOME/node scripts/dist/cli.js post-message --channel C0123456789 --text "Update: Order #1234 shipped"

# Reply to a thread
node $HOME/node scripts/dist/cli.js reply-thread --channel C0123456789 --thread 1234567890.123456 --text "Thanks for the update!"

# Get thread replies
node $HOME/node scripts/dist/cli.js get-thread --channel C0123456789 --thread 1234567890.123456

# Add a reaction
node $HOME/node scripts/dist/cli.js add-reaction --channel C0123456789 --timestamp 1234567890.123456 --reaction white_check_mark

# List users
node $HOME/node scripts/dist/cli.js get-users --limit 50

# Search messages
node $HOME/node scripts/dist/cli.js search-messages --query "order status" --limit 10
```

## How It Works

This plugin wraps an MCP (Model Context Protocol) server, providing a CLI interface that communicates with the service's MCP binary. The CLI translates commands into MCP tool calls and returns structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| MCP connection timeout | Ensure the MCP server binary is installed and accessible |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
