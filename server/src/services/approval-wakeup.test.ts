import { describe, expect, it, vi } from "vitest";

import {
  hasPendingApprovalWake,
  maybeWakeCeoForApprovalPending,
  resolveActiveCeoAgentId,
  selectActiveCeoAgentId,
  type ApprovalWakeupDeps,
  type CeoCandidate,
} from "./approval-wakeup.js";

const ISSUE = { id: "issue-1", companyId: "company-1" };

function baseInteraction(overrides: Partial<{
  id: string;
  kind: string;
  status: string;
  createdByAgentId: string | null;
}> = {}) {
  return {
    id: "interaction-1",
    kind: "request_confirmation",
    status: "pending",
    createdByAgentId: "agent-author",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ApprovalWakeupDeps> = {}): {
  deps: ApprovalWakeupDeps;
  wakeup: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  const wakeup = vi.fn(async () => ({ id: "wake-1" }));
  const info = vi.fn();
  const deps: ApprovalWakeupDeps = {
    resolveCeo: async () => "agent-ceo",
    hasPendingWake: async () => false,
    wakeup,
    logger: { info, warn: vi.fn() },
    ...overrides,
  };
  return { deps, wakeup, info };
}

describe("maybeWakeCeoForApprovalPending", () => {
  // (a) agent opens request_confirmation -> enqueue wake for the active CEO.
  it("enqueues a wake for the active CEO when an agent opens an approval gate", async () => {
    const { deps, wakeup } = makeDeps();
    const result = await maybeWakeCeoForApprovalPending(
      { issue: ISSUE, interaction: baseInteraction() },
      deps,
    );

    expect(result).toEqual({ wakened: true, reason: "queued", ceoAgentId: "agent-ceo" });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith("agent-ceo", {
      source: "on_demand",
      triggerDetail: "system",
      reason: "approval_pending",
      payload: {
        issueId: "issue-1",
        interactionId: "interaction-1",
        mutation: "approval_pending",
      },
      requestedByActorType: "agent",
      requestedByActorId: "agent-author",
      contextSnapshot: {
        issueId: "issue-1",
        source: "interaction.request_confirmation.board_approval",
      },
    });
  });

  it("also fires for request_checkbox_confirmation", async () => {
    const { deps, wakeup } = makeDeps();
    const result = await maybeWakeCeoForApprovalPending(
      { issue: ISSUE, interaction: baseInteraction({ kind: "request_checkbox_confirmation" }) },
      deps,
    );
    expect(result.wakened).toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  // (b) a second confirmation while one is already queued -> no-op (dedup).
  it("does not double-wake when an approval wake is already pending (dedup)", async () => {
    const { deps, wakeup } = makeDeps({ hasPendingWake: async () => true });
    const result = await maybeWakeCeoForApprovalPending(
      { issue: ISSUE, interaction: baseInteraction() },
      deps,
    );
    expect(result).toEqual({ wakened: false, reason: "deduped", ceoAgentId: "agent-ceo" });
    expect(wakeup).not.toHaveBeenCalled();
  });

  // (c) non-approval kinds never trigger.
  it.each(["suggest_tasks", "ask_user_questions"])(
    "does not fire for %s interactions",
    async (kind) => {
      const { deps, wakeup } = makeDeps();
      const result = await maybeWakeCeoForApprovalPending(
        { issue: ISSUE, interaction: baseInteraction({ kind }) },
        deps,
      );
      expect(result).toEqual({ wakened: false, reason: "kind_not_approval" });
      expect(wakeup).not.toHaveBeenCalled();
    },
  );

  // (d) when the CEO itself opens the confirmation -> no self-wake.
  it("does not self-wake when the CEO is the interaction author", async () => {
    const { deps, wakeup } = makeDeps({ resolveCeo: async () => "agent-ceo" });
    const result = await maybeWakeCeoForApprovalPending(
      { issue: ISSUE, interaction: baseInteraction({ createdByAgentId: "agent-ceo" }) },
      deps,
    );
    expect(result).toEqual({ wakened: false, reason: "self_wake", ceoAgentId: "agent-ceo" });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips interactions that are not pending", async () => {
    const { deps, wakeup } = makeDeps();
    const result = await maybeWakeCeoForApprovalPending(
      { issue: ISSUE, interaction: baseInteraction({ status: "accepted" }) },
      deps,
    );
    expect(result).toEqual({ wakened: false, reason: "not_pending" });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips interactions not created by an agent (board/user authored)", async () => {
    const { deps, wakeup } = makeDeps();
    const result = await maybeWakeCeoForApprovalPending(
      { issue: ISSUE, interaction: baseInteraction({ createdByAgentId: null }) },
      deps,
    );
    expect(result).toEqual({ wakened: false, reason: "not_agent_created" });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("no-ops and logs when no active CEO is resolved", async () => {
    const { deps, wakeup, info } = makeDeps({ resolveCeo: async () => null });
    const result = await maybeWakeCeoForApprovalPending(
      { issue: ISSUE, interaction: baseInteraction() },
      deps,
    );
    expect(result).toEqual({ wakened: false, reason: "no_active_ceo" });
    expect(wakeup).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("selectActiveCeoAgentId", () => {
  // (e) a paused CEO_legacy must never be chosen as the wake target.
  it("ignores a paused legacy CEO and prefers the active root CEO", () => {
    const candidates: CeoCandidate[] = [
      { id: "ceo-legacy", role: "ceo", status: "paused", reportsTo: null },
      { id: "ceo-active", role: "ceo", status: "idle", reportsTo: null },
    ];
    expect(selectActiveCeoAgentId(candidates)).toBe("ceo-active");
  });

  it("prefers the org root (reportsTo IS NULL) among active CEOs", () => {
    const candidates: CeoCandidate[] = [
      { id: "ceo-deputy", role: "ceo", status: "idle", reportsTo: "ceo-root" },
      { id: "ceo-root", role: "ceo", status: "running", reportsTo: null },
    ];
    expect(selectActiveCeoAgentId(candidates)).toBe("ceo-root");
  });

  it("falls back to the first active CEO when none is a root", () => {
    const candidates: CeoCandidate[] = [
      { id: "ceo-a", role: "ceo", status: "idle", reportsTo: "someone" },
    ];
    expect(selectActiveCeoAgentId(candidates)).toBe("ceo-a");
  });

  it("returns null when every CEO is paused or archived", () => {
    const candidates: CeoCandidate[] = [
      { id: "ceo-legacy", role: "ceo", status: "paused", reportsTo: null },
      { id: "ceo-old", role: "ceo", status: "archived", reportsTo: null },
    ];
    expect(selectActiveCeoAgentId(candidates)).toBeNull();
  });

  it("returns null when there are no CEO agents", () => {
    expect(selectActiveCeoAgentId([])).toBeNull();
  });
});

// Thin DB-resolver coverage using a fake select chain, mirroring the
// existing service test style.
function fakeSelectDb(rows: Record<string, unknown>[]) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => {
          const result = Promise.resolve(rows) as Promise<Record<string, unknown>[]> & {
            limit: (n: number) => Promise<Record<string, unknown>[]>;
          };
          result.limit = () => Promise.resolve(rows);
          return result;
        },
      }),
    })),
  } as any;
}

describe("resolveActiveCeoAgentId (db-backed)", () => {
  it("selects the active CEO from the fetched candidate rows", async () => {
    const db = fakeSelectDb([
      { id: "ceo-legacy", role: "ceo", status: "paused", reportsTo: null },
      { id: "ceo-active", role: "ceo", status: "idle", reportsTo: null },
    ]);
    expect(await resolveActiveCeoAgentId(db, "company-1")).toBe("ceo-active");
  });
});

describe("hasPendingApprovalWake (db-backed)", () => {
  it("is true when a pending wake row exists for the issue", async () => {
    const db = fakeSelectDb([{ id: "wake-1" }]);
    expect(
      await hasPendingApprovalWake(db, {
        companyId: "company-1",
        ceoAgentId: "ceo-active",
        issueId: "issue-1",
      }),
    ).toBe(true);
  });

  it("is false when no pending wake row exists", async () => {
    const db = fakeSelectDb([]);
    expect(
      await hasPendingApprovalWake(db, {
        companyId: "company-1",
        ceoAgentId: "ceo-active",
        issueId: "issue-1",
      }),
    ).toBe(false);
  });
});
