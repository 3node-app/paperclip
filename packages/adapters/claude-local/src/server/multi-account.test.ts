import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ClaudeMultiAccountStore,
  isSessionLimitError,
} from "../services/claude-multi-account.js";

describe("ClaudeMultiAccountStore", () => {
  let tmpHome: string;
  let store: ClaudeMultiAccountStore;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "claude-store-"));
    store = new ClaudeMultiAccountStore(tmpHome);
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("creates accounts with sequential ids", async () => {
    const a = await store.createAccount("Primary");
    const b = await store.createAccount("Backup");
    expect(a).toBe("account-1");
    expect(b).toBe("account-2");
    const list = await store.list();
    expect(list.map((entry) => entry.id)).toEqual(["account-1", "account-2"]);
  });

  it("returns null when no account has credentials", async () => {
    await store.createAccount("A");
    expect(await store.resolveAccountForUse()).toBeNull();
  });

  it("selects an account once it has credentials and marks it active", async () => {
    await store.createAccount("Primary");
    await fs.writeFile(store.credentialsFile("account-1"), '{"ok":true}', {
      mode: 0o600,
    });
    const resolved = await store.resolveAccountForUse();
    expect(resolved).toEqual({
      id: "account-1",
      dir: store.accountDir("account-1"),
    });
    const list = await store.list();
    expect(list[0].isActive).toBe(true);
  });

  it("rotates to the next account when current is marked exhausted", async () => {
    await store.createAccount("Primary");
    await store.createAccount("Backup");
    await fs.writeFile(store.credentialsFile("account-1"), '{"ok":true}');
    await fs.writeFile(store.credentialsFile("account-2"), '{"ok":true}');
    await store.resolveAccountForUse();
    await store.markExhausted("account-1", "test");
    const next = await store.resolveAccountForUse();
    expect(next?.id).toBe("account-2");
  });

  it("returns null when every account is exhausted", async () => {
    await store.createAccount("A");
    await store.createAccount("B");
    await fs.writeFile(store.credentialsFile("account-1"), '{}');
    await fs.writeFile(store.credentialsFile("account-2"), '{}');
    await store.markExhausted("account-1");
    await store.markExhausted("account-2");
    expect(await store.resolveAccountForUse()).toBeNull();
  });

  it("clears exhaustion after the 24h grace window", async () => {
    await store.createAccount("A");
    await fs.writeFile(store.credentialsFile("account-1"), '{}');
    await store.markExhausted("account-1");
    // Rewrite meta with an exhaustion timestamp older than the grace window.
    const meta = await store.readMeta("account-1");
    expect(meta).not.toBeNull();
    meta!.quotaExhaustedAt = new Date(
      Date.now() - 25 * 60 * 60 * 1000,
    ).toISOString();
    await store.writeMeta("account-1", meta!);
    const next = await store.resolveAccountForUse();
    expect(next?.id).toBe("account-1");
  });

  it("recognizes session-limit error patterns", () => {
    expect(
      isSessionLimitError("subtype=success: You've hit your session limit"),
    ).toBe(true);
    expect(isSessionLimitError("You have reached your weekly limit")).toBe(
      true,
    );
    expect(isSessionLimitError("Random network blip")).toBe(false);
  });
});
