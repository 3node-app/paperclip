import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests } from "@paperclipai/db";

/**
 * NODE-134 (Patch A of NODE-133) — auto-wake the active CEO when an agent
 * opens an approval-pending interaction (a board confirmation) on an issue.
 *
 * The wiring lives in the `POST /issues/:id/interactions` handler and is
 * strictly fire-and-forget: it must never derail interaction creation. The
 * resolution + dedup logic is split out here so it can be unit tested with an
 * injected wakeup runner (the NODE-128 pattern).
 */

/** Interaction kinds that represent a board approval gate. */
export const APPROVAL_WAKE_INTERACTION_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;

/** Wakeup statuses that count as "already pending" for dedup. */
export const PENDING_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

/** CEO agent statuses that make a CEO ineligible to be woken. */
export const INACTIVE_CEO_STATUSES = ["paused", "archived"] as const;

type ApprovalWakeKind = (typeof APPROVAL_WAKE_INTERACTION_KINDS)[number];

function isApprovalWakeKind(kind: string): kind is ApprovalWakeKind {
  return (APPROVAL_WAKE_INTERACTION_KINDS as readonly string[]).includes(kind);
}

export type CeoCandidate = {
  id: string;
  role: string;
  status: string;
  reportsTo: string | null;
};

/**
 * Pure selection of the active CEO from a candidate list. Excludes paused /
 * archived agents (guards against the known CEO_legacy pausado in some
 * companies) and prefers the org root (reportsTo IS NULL).
 */
export function selectActiveCeoAgentId(candidates: CeoCandidate[]): string | null {
  const active = candidates.filter(
    (c) =>
      c.role === "ceo"
      && !(INACTIVE_CEO_STATUSES as readonly string[]).includes(c.status),
  );
  if (active.length === 0) return null;
  const root = active.find((c) => c.reportsTo === null);
  return (root ?? active[0]).id;
}

/** Resolve the active CEO agent id for a company, or null when none exists. */
export async function resolveActiveCeoAgentId(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      id: agents.id,
      role: agents.role,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.role, "ceo"),
      ),
    );
  return selectActiveCeoAgentId(rows as CeoCandidate[]);
}

/**
 * Dedup check (criterio 4): true when a wakeup is already pending for this CEO
 * targeting this issue. Mirrors the heartbeat coalescing query.
 */
export async function hasPendingApprovalWake(
  db: Pick<Db, "select">,
  args: { companyId: string; ceoAgentId: string; issueId: string },
): Promise<boolean> {
  const existing = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, args.companyId),
        eq(agentWakeupRequests.agentId, args.ceoAgentId),
        inArray(agentWakeupRequests.status, [...PENDING_WAKE_STATUSES]),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${args.issueId}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return existing !== null;
}

export type ApprovalWakeupLogger = {
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
};

export interface ApprovalWakeupDeps {
  /** Resolve the active CEO agent id for the company. */
  resolveCeo: (companyId: string) => Promise<string | null>;
  /** Dedup check: is an approval wake already pending for this CEO+issue? */
  hasPendingWake: (args: {
    companyId: string;
    ceoAgentId: string;
    issueId: string;
  }) => Promise<boolean>;
  /** The injected wakeup runner (heartbeat.wakeup in production). */
  wakeup: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
  logger?: ApprovalWakeupLogger;
}

export type ApprovalWakeupOutcome =
  | "queued"
  | "kind_not_approval"
  | "not_pending"
  | "not_agent_created"
  | "no_active_ceo"
  | "self_wake"
  | "deduped";

export type ApprovalWakeupResult = {
  wakened: boolean;
  reason: ApprovalWakeupOutcome;
  ceoAgentId?: string;
};

/**
 * Decide whether to wake the active CEO for an approval-pending interaction and,
 * if so, enqueue it through the injected runner.
 *
 * Gate (all must hold): kind ∈ approval kinds; status pending; created by an
 * agent; an active CEO exists; the CEO is not the creator (no self-wake); and no
 * wake is already pending for this CEO+issue.
 */
export async function maybeWakeCeoForApprovalPending(
  input: {
    issue: { id: string; companyId: string };
    interaction: {
      id: string;
      kind: string;
      status: string;
      createdByAgentId: string | null;
    };
  },
  deps: ApprovalWakeupDeps,
): Promise<ApprovalWakeupResult> {
  const { issue, interaction } = input;

  if (!isApprovalWakeKind(interaction.kind)) {
    return { wakened: false, reason: "kind_not_approval" };
  }
  if (interaction.status !== "pending") {
    return { wakened: false, reason: "not_pending" };
  }
  if (!interaction.createdByAgentId) {
    return { wakened: false, reason: "not_agent_created" };
  }

  const ceoAgentId = await deps.resolveCeo(issue.companyId);
  if (!ceoAgentId) {
    deps.logger?.info?.(
      { issueId: issue.id, companyId: issue.companyId, interactionId: interaction.id },
      "approval-wakeup: no active CEO resolved; skipping",
    );
    return { wakened: false, reason: "no_active_ceo" };
  }

  // No self-wake: the CEO who opened the confirmation should not wake itself.
  if (ceoAgentId === interaction.createdByAgentId) {
    return { wakened: false, reason: "self_wake", ceoAgentId };
  }

  const alreadyPending = await deps.hasPendingWake({
    companyId: issue.companyId,
    ceoAgentId,
    issueId: issue.id,
  });
  if (alreadyPending) {
    return { wakened: false, reason: "deduped", ceoAgentId };
  }

  await deps.wakeup(ceoAgentId, {
    source: "on_demand",
    triggerDetail: "system",
    reason: "approval_pending",
    payload: {
      issueId: issue.id,
      interactionId: interaction.id,
      mutation: "approval_pending",
    },
    requestedByActorType: "agent",
    requestedByActorId: interaction.createdByAgentId,
    contextSnapshot: {
      issueId: issue.id,
      source: "interaction.request_confirmation.board_approval",
    },
  });

  return { wakened: true, reason: "queued", ceoAgentId };
}
