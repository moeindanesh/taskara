-- PostgreSQL truncated the original generated name at 63 bytes. Give the index a stable concise
-- name so schema diffing is identical on both upgraded and fresh databases.
ALTER INDEX "SupportSavedView_workspaceId_visibility_departmentId_updatedAt_"
  RENAME TO "SupportSavedView_scope_updated_idx";
