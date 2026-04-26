# Implementation Plan

## Phase 1: Foundation

- Bun monorepo with API, web, database, Mattermost worker, and Codex plugin.
- PostgreSQL schema with Prisma.
- Workspace/user/team/project/task/comment/activity models.
- Header-based local identity for fast integration testing.

## Phase 2: Task Manager MVP

- Project and subproject CRUD.
- Task CRUD with status, priority, assignee, due date, labels, comments, and dependencies.
- Saved views and cycle endpoints.
- Notification surfaces and activity stream.

## Phase 3: Mattermost First-Class Client

- Slash command endpoint.
- Project-channel binding.
- Thread-to-task proposal workflow.
- Interactive buttons and bot-posted daily digests.
- Mattermost user mapping hardening.

## Phase 4: Codex Plugin

- Taskara plugin manifest and skill.
- Helper script for create/search/update/comment/daily-plan.
- Optional MCP server if direct tool exposure is required later.

## Phase 5: Agentic Workflows

- Triage suggestions.
- Duplicate detection.
- Stale task follow-ups.
- Project health reports.
- Apply/reject flow for all proposed actions.

## Phase 6: Hardening

- Real auth: OIDC/SSO or Mattermost OAuth.
- RBAC enforcement beyond local headers.
- Tests around permissions and agent action application.
- Queue-backed reminders and retries.
- Observability, backups, import/export.
