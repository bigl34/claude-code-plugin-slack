import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type SlackEditLockOptions = {
  lockRoot?: string;
  timeoutMs?: number;
  retryMs?: number;
  removeLock?: (path: string) => Promise<void>;
};

export type SlackEditLockResult<T> = {
  value: T;
  cleanupWarning?: string;
};

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 25;

function defaultLockRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  return join(tmpdir(), `slack-manager-edit-locks-${uid}`);
}

export function slackEditLockPath(
  channelId: string,
  timestamp: string,
  lockRoot = defaultLockRoot(),
): string {
  const key = createHash("sha256")
    .update(channelId, "utf8")
    .update("\0", "utf8")
    .update(timestamp, "utf8")
    .digest("hex");
  return join(lockRoot, `${key}.lock`);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensurePrivateSlackEditLockRoot(
  lockRoot: string,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined,
): Promise<void> {
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(lockRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Slack edit lock root must be a real directory, not a symlink");
  }
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error("Slack edit lock root has a different owner");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Slack edit lock root must not grant group or other permissions");
  }
}

export async function withSlackEditLock<T>(
  channelId: string,
  timestamp: string,
  operation: () => Promise<T>,
  options: SlackEditLockOptions = {},
): Promise<SlackEditLockResult<T>> {
  const lockRoot = options.lockRoot ?? defaultLockRoot();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("Slack edit lock timeoutMs must be a non-negative integer");
  }
  if (!Number.isInteger(retryMs) || retryMs < 1) {
    throw new Error("Slack edit lock retryMs must be a positive integer");
  }

  await ensurePrivateSlackEditLockRoot(lockRoot);
  const lockPath = slackEditLockPath(channelId, timestamp, lockRoot);
  const deadline = Date.now() + timeoutMs;
  const removeLock = options.removeLock ?? (async (path: string) => {
    await rm(path, { recursive: true, force: true });
  });

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Another local process is editing Slack message ${channelId}/${timestamp}; refusing overlapping edit`,
        );
      }
      await wait(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }

  const ownerToken = randomUUID();
  try {
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, ownerToken, acquiredAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (setupError) {
    try {
      await removeLock(lockPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        "Slack edit lock setup and cleanup both failed; edit was not attempted",
      );
    }
    throw setupError;
  }

  let value: T;
  try {
    value = await operation();
  } catch (operationError) {
    try {
      await removeLock(lockPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Slack edit failed before success was confirmed and lock cleanup also failed",
      );
    }
    throw operationError;
  }

  try {
    await removeLock(lockPath);
    return { value };
  } catch (cleanupError) {
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    return {
      value,
      cleanupWarning:
        "Slack accepted the message edit, but the local edit lock could not be cleaned up. "
        + `Do not retry the edit; verify the Slack message and remove the stale lock manually at ${lockPath}. `
        + `(${detail})`,
    };
  }
}
