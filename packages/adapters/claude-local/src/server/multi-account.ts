// Multi-account Claude credential rotation.
//
// When one account hits its OAuth session/weekly limit, the adapter rotates
// to the next available account and retries. A daily reset (24h since
// quota_exhausted_at) makes a previously exhausted account eligible again.
//
// Storage layout (under /paperclip/.claude/credentials-store):
//   account-1/.credentials.json   ← OAuth from `claude /login` with CLAUDE_CONFIG_DIR
//   account-1/meta.json           ← { label, created_at, quota_exhausted_at?, last_status_check?, percent_used? }
//   account-2/...
//   active.json                   ← { current: "account-1", order: ["account-1","account-2"] }
//
// The adapter sets env.CLAUDE_CONFIG_DIR to the active account's directory.
// Anthropic's Claude CLI reads `.credentials.json` from there.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  captureClaudeCliUsageTextForConfigDir,
  parseClaudeCliUsageText,
  toPercent,
} from "./quota.js";

const STORE_DIRNAME = "credentials-store";
const ACTIVE_FILE = "active.json";
const META_FILENAME = "meta.json";
const CREDENTIALS_FILENAME = ".credentials.json";

const RESET_GRACE_MS = 24 * 60 * 60 * 1000; // 24h since exhausted ⇒ assume Anthropic reset.

const SESSION_LIMIT_PATTERNS = [
  /You['']ve hit your session limit/i,
  /you have reached your.*limit/i,
  /reached the weekly limit/i,
  /quota.*exhausted/i,
];

export interface AccountMeta {
  label: string;
  createdAt: string;
  quotaExhaustedAt?: string | null;
  lastStatusCheckAt?: string | null;
  percentUsed?: number | null;
  lastUsedAt?: string | null;
}

export interface AccountSummary {
  id: string;
  label: string;
  isActive: boolean;
  isExhausted: boolean;
  percentUsed: number | null;
  hasCredentials: boolean;
  createdAt: string;
}

export interface ActiveState {
  current: string | null;
  order: string[];
}

export class ClaudeMultiAccountStore {
  constructor(private readonly homeDir: string) {}

  private get storeDir(): string {
    return path.join(this.homeDir, ".claude", STORE_DIRNAME);
  }

  private get activeFile(): string {
    return path.join(this.storeDir, ACTIVE_FILE);
  }

  accountDir(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid account id: ${id}`);
    }
    return path.join(this.storeDir, id);
  }

  credentialsFile(id: string): string {
    return path.join(this.accountDir(id), CREDENTIALS_FILENAME);
  }

  metaFile(id: string): string {
    return path.join(this.accountDir(id), META_FILENAME);
  }

  async ensureStore(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true, mode: 0o700 });
  }

  async readActive(): Promise<ActiveState> {
    try {
      const raw = await fs.readFile(this.activeFile, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ActiveState>;
      return {
        current: typeof parsed.current === "string" ? parsed.current : null,
        order: Array.isArray(parsed.order)
          ? parsed.order.filter((v): v is string => typeof v === "string")
          : [],
      };
    } catch {
      return { current: null, order: [] };
    }
  }

  async writeActive(state: ActiveState): Promise<void> {
    await this.ensureStore();
    await fs.writeFile(this.activeFile, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  }

  async readMeta(id: string): Promise<AccountMeta | null> {
    try {
      const raw = await fs.readFile(this.metaFile(id), "utf-8");
      return JSON.parse(raw) as AccountMeta;
    } catch {
      return null;
    }
  }

  async writeMeta(id: string, meta: AccountMeta): Promise<void> {
    await fs.mkdir(this.accountDir(id), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.metaFile(id), JSON.stringify(meta, null, 2), {
      mode: 0o600,
    });
  }

  async hasCredentials(id: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.credentialsFile(id));
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  async list(): Promise<AccountSummary[]> {
    const active = await this.readActive();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.storeDir);
    } catch {
      return [];
    }
    const accountIds = entries.filter((entry) => /^account-/.test(entry));
    const orderedIds = [
      ...active.order.filter((id) => accountIds.includes(id)),
      ...accountIds.filter((id) => !active.order.includes(id)),
    ];
    const out: AccountSummary[] = [];
    for (const id of orderedIds) {
      const meta = (await this.readMeta(id)) ?? {
        label: id,
        createdAt: new Date().toISOString(),
      };
      out.push({
        id,
        label: meta.label,
        isActive: active.current === id,
        isExhausted: this.isStillExhausted(meta),
        percentUsed: meta.percentUsed ?? null,
        hasCredentials: await this.hasCredentials(id),
        createdAt: meta.createdAt,
      });
    }
    return out;
  }

  private isStillExhausted(meta: AccountMeta): boolean {
    if (!meta.quotaExhaustedAt) return false;
    const exhaustedAt = new Date(meta.quotaExhaustedAt).getTime();
    if (Number.isNaN(exhaustedAt)) return false;
    return Date.now() - exhaustedAt < RESET_GRACE_MS;
  }

  /**
   * Return the directory of the account that should be used for the next
   * Claude spawn, or null if no usable account exists. Updates active.json
   * if the current pick changed.
   */
  async resolveAccountForUse(): Promise<{ id: string; dir: string } | null> {
    await this.ensureStore();
    const all = await this.list();
    const candidates = all.filter((a) => a.hasCredentials && !a.isExhausted);
    if (candidates.length === 0) return null;
    const active = await this.readActive();
    // Prefer the currently active one if still eligible.
    const currentStill: AccountSummary | undefined = active.current
      ? candidates.find((c) => c.id === active.current)
      : undefined;
    const picked: AccountSummary = currentStill ?? candidates[0];
    if (active.current !== picked.id) {
      const newOrder = Array.from(
        new Set([picked.id, ...active.order, ...all.map((a) => a.id)]),
      );
      await this.writeActive({ current: picked.id, order: newOrder });
    }
    // Touch last-used timestamp.
    const meta = (await this.readMeta(picked.id)) ?? {
      label: picked.label,
      createdAt: picked.createdAt,
    };
    meta.lastUsedAt = new Date().toISOString();
    await this.writeMeta(picked.id, meta);
    return { id: picked.id, dir: this.accountDir(picked.id) };
  }

  async markExhausted(id: string, reason?: string): Promise<void> {
    const meta = (await this.readMeta(id)) ?? {
      label: id,
      createdAt: new Date().toISOString(),
    };
    meta.quotaExhaustedAt = new Date().toISOString();
    await this.writeMeta(id, meta);
    if (reason) {
      // Best-effort breadcrumb; log to stderr so it surfaces in heartbeat logs.
      // eslint-disable-next-line no-console
      console.warn(
        `[claude-multi-account] account ${id} marked exhausted: ${reason}`,
      );
    }
    // If this was the active one, immediately pick the next.
    const active = await this.readActive();
    if (active.current === id) {
      const next = await this.resolveAccountForUse();
      if (next === null) {
        await this.writeActive({ current: null, order: active.order });
      }
    }
  }

  async updateStatusCheck(
    id: string,
    percentUsed: number | null,
  ): Promise<void> {
    const meta = (await this.readMeta(id)) ?? {
      label: id,
      createdAt: new Date().toISOString(),
    };
    meta.lastStatusCheckAt = new Date().toISOString();
    meta.percentUsed = percentUsed;
    await this.writeMeta(id, meta);
  }

  async createAccount(label: string): Promise<string> {
    await this.ensureStore();
    const existing = await this.list();
    const nextNumber = existing.length + 1;
    const id = `account-${nextNumber}`;
    await this.writeMeta(id, {
      label: label.trim() || id,
      createdAt: new Date().toISOString(),
    });
    const active = await this.readActive();
    await this.writeActive({
      current: active.current,
      order: Array.from(new Set([...active.order, id])),
    });
    return id;
  }
}

/** True if a stderr/stdout chunk indicates the account hit its OAuth quota. */
export function isSessionLimitError(output: string): boolean {
  return SESSION_LIMIT_PATTERNS.some((pattern) => pattern.test(output));
}

/** Build a store using the agent runtime HOME (default /paperclip). */
export function createDefaultStore(home?: string): ClaudeMultiAccountStore {
  const resolved = home ?? process.env.HOME ?? "/paperclip";
  return new ClaudeMultiAccountStore(resolved);
}

/**
 * Probe Anthropic for the given account's current usage and persist the
 * highest-percent window into its meta.json. Returns the percent (0-100) or
 * null when the probe could not be parsed.
 */
export async function probeAccountUsagePercent(
  store: ClaudeMultiAccountStore,
  accountId: string,
  timeoutMs = 12_000,
): Promise<number | null> {
  const dir = store.accountDir(accountId);
  let usageText: string;
  try {
    usageText = await captureClaudeCliUsageTextForConfigDir(dir, timeoutMs);
  } catch {
    await store.updateStatusCheck(accountId, null);
    return null;
  }
  const windows = parseClaudeCliUsageText(usageText);
  if (windows.length === 0) {
    await store.updateStatusCheck(accountId, null);
    return null;
  }
  // Use the worst-case window — usually weekly-all-models for Max plans.
  let worst = 0;
  for (const window of windows) {
    const pct = toPercent(window.usedPercent);
    if (pct !== null && pct > worst) worst = pct;
  }
  const value = worst > 0 ? worst : null;
  await store.updateStatusCheck(accountId, value);
  return value;
}

/**
 * Decide whether the squad should be auto-paused based on the current state
 * of the credentials store. Returns a reason string when pause is warranted,
 * or null otherwise.
 *
 * Policy: only pause when EVERY non-exhausted account has exceeded the
 * threshold (i.e. there is no remaining headroom anywhere). Single exhausted
 * accounts do not pause the squad — rotation handles them.
 */
export async function evaluateAutoPause(
  store: ClaudeMultiAccountStore,
  thresholdPercent: number,
): Promise<{ shouldPause: boolean; reason: string | null }> {
  if (
    !Number.isFinite(thresholdPercent) ||
    thresholdPercent <= 0 ||
    thresholdPercent > 100
  ) {
    return { shouldPause: false, reason: null };
  }
  const accounts = await store.list();
  const eligible = accounts.filter(
    (account) => account.hasCredentials && !account.isExhausted,
  );
  if (eligible.length === 0) {
    // No usable accounts at all → rotation already exhausted everything.
    return {
      shouldPause: true,
      reason: `auto-pause: no eligible Claude accounts available (${accounts.length} total)`,
    };
  }
  const stillBelow = eligible.filter(
    (account) =>
      account.percentUsed === null ||
      account.percentUsed < thresholdPercent,
  );
  if (stillBelow.length > 0) {
    return { shouldPause: false, reason: null };
  }
  return {
    shouldPause: true,
    reason: `auto-pause: all ${eligible.length} eligible Claude account(s) at or above ${thresholdPercent}% usage`,
  };
}
