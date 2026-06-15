import { describe, expect, it, vi } from "vitest";
import {
  queueIssueAssignmentWakeup,
  type ResolveIssueWakeMaterialization,
} from "../services/issue-assignment-wakeup.js";
import type { ProjectGitWorkspaceMaterialization } from "../services/project-workspace-materialization-read.js";

function fakeHeartbeat() {
  const wakeup = vi.fn().mockResolvedValue(undefined);
  return { deps: { wakeup }, wakeup };
}

function resolver(state: ProjectGitWorkspaceMaterialization | null): ResolveIssueWakeMaterialization {
  return vi.fn().mockResolvedValue(state);
}

const baseInput = {
  reason: "issue_assigned",
  mutation: "create",
  contextSource: "test",
} as const;

describe("queueIssueAssignmentWakeup — NODE-130 materialization guard", () => {
  it("suppresses the wake when the project git workspace materialization failed", async () => {
    const { deps, wakeup } = fakeHeartbeat();
    const result = await queueIssueAssignmentWakeup({
      ...baseInput,
      heartbeat: deps,
      issue: { id: "i1", assigneeAgentId: "a1", status: "todo", projectId: "p1" },
      resolveMaterialization: resolver({
        workspaceId: "w1",
        status: "failed",
        error: "clone_auth_failed: bad credentials",
      }),
    });

    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({
      wake: "suppressed",
      reason: "materialization_failed",
      materializationError: "clone_auth_failed: bad credentials",
    });
  });

  it("wakes normally when materialization is ready", async () => {
    const { deps, wakeup } = fakeHeartbeat();
    const result = await queueIssueAssignmentWakeup({
      ...baseInput,
      heartbeat: deps,
      issue: { id: "i1", assigneeAgentId: "a1", status: "todo", projectId: "p1" },
      resolveMaterialization: resolver({ workspaceId: "w1", status: "ready", error: null }),
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ wake: "queued" });
  });

  it("wakes when there is no managed git checkout (resolver returns null)", async () => {
    const { deps, wakeup } = fakeHeartbeat();
    const result = await queueIssueAssignmentWakeup({
      ...baseInput,
      heartbeat: deps,
      issue: { id: "i1", assigneeAgentId: "a1", status: "todo", projectId: "p1" },
      resolveMaterialization: resolver(null),
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ wake: "queued" });
  });

  it("does not couple to pending/cloning — Camada B is the safety net there", async () => {
    for (const status of ["pending", "cloning"] as const) {
      const { deps, wakeup } = fakeHeartbeat();
      const result = await queueIssueAssignmentWakeup({
        ...baseInput,
        heartbeat: deps,
        issue: { id: "i1", assigneeAgentId: "a1", status: "todo", projectId: "p1" },
        resolveMaterialization: resolver({ workspaceId: "w1", status, error: null }),
      });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ wake: "queued" });
    }
  });

  it("never blocks a legitimate wake when the guard lookup throws", async () => {
    const { deps, wakeup } = fakeHeartbeat();
    const result = await queueIssueAssignmentWakeup({
      ...baseInput,
      heartbeat: deps,
      issue: { id: "i1", assigneeAgentId: "a1", status: "todo", projectId: "p1" },
      resolveMaterialization: vi.fn().mockRejectedValue(new Error("db down")),
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ wake: "queued" });
  });

  it("skips before any guard work when the issue is in backlog", async () => {
    const { deps, wakeup } = fakeHeartbeat();
    const resolve = resolver({ workspaceId: "w1", status: "failed", error: "x" });
    const result = await queueIssueAssignmentWakeup({
      ...baseInput,
      heartbeat: deps,
      issue: { id: "i1", assigneeAgentId: "a1", status: "backlog", projectId: "p1" },
      resolveMaterialization: resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({ wake: "skipped", reason: "backlog" });
  });

  it("skips when there is no assignee", async () => {
    const { deps, wakeup } = fakeHeartbeat();
    const result = await queueIssueAssignmentWakeup({
      ...baseInput,
      heartbeat: deps,
      issue: { id: "i1", assigneeAgentId: null, status: "todo", projectId: "p1" },
    });

    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({ wake: "skipped", reason: "no_assignee" });
  });

  it("guard is inert without a resolver or db (backward compatible)", async () => {
    const { deps, wakeup } = fakeHeartbeat();
    const result = await queueIssueAssignmentWakeup({
      ...baseInput,
      heartbeat: deps,
      issue: { id: "i1", assigneeAgentId: "a1", status: "todo", projectId: "p1" },
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ wake: "queued" });
  });
});
