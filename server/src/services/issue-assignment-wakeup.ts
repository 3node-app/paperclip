import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  readProjectGitWorkspaceMaterialization,
  type ProjectGitWorkspaceMaterialization,
} from "./project-workspace-materialization-read.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

/**
 * Resolver for the NODE-130 wake guard. Returns the managed git checkout
 * materialization state of the issue's project, or `null` when there is no
 * managed checkout to guard against. Injectable so the guard can be unit-tested
 * without a database.
 */
export type ResolveIssueWakeMaterialization = (
  projectId: string,
) => Promise<ProjectGitWorkspaceMaterialization | null>;

export type IssueAssignmentWakeupResult =
  | { wake: "queued" }
  | { wake: "failed" }
  | { wake: "skipped"; reason: "no_assignee" | "backlog" }
  | { wake: "suppressed"; reason: "materialization_failed"; materializationError: string | null };

export async function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string; projectId?: string | null };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
  /** When provided, enables the NODE-130 materialization wake guard. */
  db?: Db;
  /** Test seam overriding the DB-backed materialization lookup. */
  resolveMaterialization?: ResolveIssueWakeMaterialization;
}): Promise<IssueAssignmentWakeupResult> {
  if (!input.issue.assigneeAgentId) return { wake: "skipped", reason: "no_assignee" };
  if (input.issue.status === "backlog") return { wake: "skipped", reason: "backlog" };

  // NODE-130 wake guard: if the issue's project has a managed git checkout whose
  // clone failed, do not wake the assignee. Waking onto an unmaterialized
  // workspace loops on `setup_failed`; the structured error is already surfaced
  // via the project GET payload (materialization_status / materialization_error).
  const db = input.db;
  const resolveMaterialization =
    input.resolveMaterialization ??
    (db ? (projectId: string) => readProjectGitWorkspaceMaterialization(db, projectId) : null);
  if (resolveMaterialization && input.issue.projectId) {
    try {
      const materialization = await resolveMaterialization(input.issue.projectId);
      if (materialization?.status === "failed") {
        logger.warn(
          {
            issueId: input.issue.id,
            projectId: input.issue.projectId,
            workspaceId: materialization.workspaceId,
            materializationError: materialization.error,
          },
          "suppressing issue assignment wake: project git workspace materialization failed",
        );
        return {
          wake: "suppressed",
          reason: "materialization_failed",
          materializationError: materialization.error,
        };
      }
    } catch (err) {
      // The guard must never block a legitimate wake on its own failure.
      logger.warn(
        { err, issueId: input.issue.id, projectId: input.issue.projectId },
        "issue assignment wake guard failed to read materialization; proceeding to wake",
      );
    }
  }

  try {
    await input.heartbeat.wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    });
    return { wake: "queued" };
  } catch (err) {
    logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
    if (input.rethrowOnError) throw err;
    return { wake: "failed" };
  }
}
