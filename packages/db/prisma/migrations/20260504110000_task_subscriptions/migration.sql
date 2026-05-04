CREATE TABLE "TaskSubscription" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskSubscription_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TaskSubscription" ADD CONSTRAINT "TaskSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskSubscription" ADD CONSTRAINT "TaskSubscription_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskSubscription" ADD CONSTRAINT "TaskSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "_taskara_jsonb_or_null"("raw" TEXT)
RETURNS JSONB AS $$
BEGIN
    IF "raw" IS NULL OR left(btrim("raw"), 1) <> '{' THEN
        RETURN NULL;
    END IF;

    RETURN "raw"::JSONB;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION "_taskara_jsonb_mention_user_ids"("document" JSONB)
RETURNS TABLE("userId" UUID) AS $$
    WITH RECURSIVE nodes("value") AS (
        SELECT "document"
        WHERE "document" IS NOT NULL
        UNION ALL
        SELECT child."value"
        FROM nodes
        CROSS JOIN LATERAL (
            SELECT jsonb_array_elements(
                CASE WHEN jsonb_typeof(nodes."value") = 'array' THEN nodes."value" ELSE '[]'::JSONB END
            ) AS "value"
            UNION ALL
            SELECT object_values."value"
            FROM jsonb_each(
                CASE WHEN jsonb_typeof(nodes."value") = 'object' THEN nodes."value" ELSE '{}'::JSONB END
            ) AS object_values("key", "value")
        ) AS child
    ),
    mention_user_ids AS (
        SELECT COALESCE(
            nodes."value" ->> 'mentionUserId',
            nodes."value" #>> '{attrs,mentionUserId}',
            nodes."value" #>> '{attrs,userId}'
        ) AS "userId"
        FROM nodes
        WHERE jsonb_typeof(nodes."value") = 'object'
          AND nodes."value" ->> 'type' = 'mention'
    )
    SELECT DISTINCT "userId"::UUID
    FROM mention_user_ids
    WHERE "userId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$ LANGUAGE sql IMMUTABLE;

WITH task_participants AS (
    SELECT "workspaceId", "id" AS "taskId", "reporterId" AS "userId", "createdAt"
    FROM "Task"
    WHERE "reporterId" IS NOT NULL
    UNION ALL
    SELECT "workspaceId", "id" AS "taskId", "assigneeId" AS "userId", "createdAt"
    FROM "Task"
    WHERE "assigneeId" IS NOT NULL
    UNION ALL
    SELECT "Task"."workspaceId", "Task"."id" AS "taskId", mentions."userId", "Task"."createdAt"
    FROM "Task"
    CROSS JOIN LATERAL "_taskara_jsonb_mention_user_ids"("_taskara_jsonb_or_null"("Task"."description")) AS mentions
    WHERE "Task"."description" IS NOT NULL
),
valid_task_participants AS (
    SELECT
        task_participants."workspaceId",
        task_participants."taskId",
        task_participants."userId",
        MIN(task_participants."createdAt") AS "createdAt"
    FROM task_participants
    INNER JOIN "WorkspaceMember"
        ON "WorkspaceMember"."workspaceId" = task_participants."workspaceId"
       AND "WorkspaceMember"."userId" = task_participants."userId"
    GROUP BY task_participants."workspaceId", task_participants."taskId", task_participants."userId"
)
INSERT INTO "TaskSubscription" ("id", "workspaceId", "taskId", "userId", "createdAt")
SELECT
    (
        substr(md5("taskId"::text || ':' || "userId"::text), 1, 8) || '-' ||
        substr(md5("taskId"::text || ':' || "userId"::text), 9, 4) || '-' ||
        substr(md5("taskId"::text || ':' || "userId"::text), 13, 4) || '-' ||
        substr(md5("taskId"::text || ':' || "userId"::text), 17, 4) || '-' ||
        substr(md5("taskId"::text || ':' || "userId"::text), 21, 12)
    )::uuid,
    "workspaceId",
    "taskId",
    "userId",
    "createdAt"
FROM valid_task_participants;

CREATE UNIQUE INDEX "TaskSubscription_taskId_userId_key" ON "TaskSubscription"("taskId", "userId");
CREATE INDEX "TaskSubscription_workspaceId_userId_createdAt_idx" ON "TaskSubscription"("workspaceId", "userId", "createdAt");
CREATE INDEX "TaskSubscription_taskId_idx" ON "TaskSubscription"("taskId");

DROP FUNCTION "_taskara_jsonb_mention_user_ids"(JSONB);
DROP FUNCTION "_taskara_jsonb_or_null"(TEXT);
