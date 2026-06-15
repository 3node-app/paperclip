import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import type { ProjectWorkspaceMaterializationStatus } from "@paperclipai/shared";

/**
 * NODE-130 — lean, dependency-light read model for a project's managed git
 * checkout materialization state. Kept separate from
 * `project-workspace-materialization.ts` (which pulls in the heartbeat/clone
 * stack) so the assignment wake guard can import the read without that
 * transitive weight.
 */
export interface ProjectGitWorkspaceMaterialization {
  workspaceId: string;
  status: ProjectWorkspaceMaterializationStatus;
  error: string | null;
}

/**
 * Read the materialization state of a project's managed git checkout, for the
 * assignment wake guard. Prefers the primary `git_repo` workspace (falling back
 * to the oldest), since that is what `materializeProjectWorkspace` clones on
 * project create. Returns `null` when the project has no managed git checkout
 * (nothing to guard against).
 */
export async function readProjectGitWorkspaceMaterialization(
  db: Db,
  projectId: string,
): Promise<ProjectGitWorkspaceMaterialization | null> {
  const rows = await db
    .select({
      id: projectWorkspaces.id,
      materializationStatus: projectWorkspaces.materializationStatus,
      materializationError: projectWorkspaces.materializationError,
    })
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.sourceType, "git_repo")))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.id,
    status: row.materializationStatus as ProjectWorkspaceMaterializationStatus,
    error: row.materializationError ?? null,
  };
}
