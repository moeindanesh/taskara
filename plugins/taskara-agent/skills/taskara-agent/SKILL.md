---
name: taskara-agent
description: Use native Taskara MCP tools from Codex to create, search, update, assign, summarize, plan, report on, and administer project milestones and team tasks through the Taskara API.
---

# Taskara Agent

Use native tools when the user wants to interact with Taskara milestones, tasks, projects, planning workflows, or workspace users.

## Environment

The MCP server reads:

- `TASKARA_API_URL`
- `TASKARA_USER_EMAIL`
- `TASKARA_WORKSPACE_SLUG`

## Native Tools

The plugin exposes these MCP tools:

- `check_connection`
- `list_projects`
- `create_project`
- `summarize_project`
- `list_milestones`
- `create_milestone`
- `update_milestone`
- `summarize_milestone`
- `assign_task_to_milestone`
- `search_tasks`
- `list_my_tasks`
- `get_task`
- `create_task`
- `update_task`
- `comment_on_task`
- `propose_tasks_from_text`
- `apply_agent_action`
- `generate_daily_plan`
- `plan_work`
- `triage_backlog`
- `detect_blockers`
- `generate_weekly_report`
- `list_users`
- `create_user`
- `update_user_role`

## Safety

- Ask for confirmation before applying bulk changes.
- Do not mark tasks `DONE` or `CANCELED` unless the user explicitly asks.
- Do not complete, cancel, archive, or otherwise change milestone lifecycle implicitly. Keep those actions deliberate and preserve unfinished-task policy decisions.
- Assign tasks only to an open milestone in the same project; let the API enforce this invariant and report its error instead of retrying with a different milestone silently.
- Use a milestone's returned `version` for metadata updates. On conflict, refetch and show the user what changed before retrying.
- Use `propose_tasks_from_text` for long plans or discussions, then apply selected proposed actions with `apply_agent_action`.
- Include task keys in summaries after mutations.
- User-management tools require `OWNER` or `ADMIN` in Taskara.

## Fallback CLI

The old helper script is still available for manual testing:

```bash
bun scripts/taskara.mjs list-my-tasks
bun scripts/taskara.mjs search-tasks --query "blocked backend"
bun scripts/taskara.mjs create-task --project-id "<uuid>" --title "Implement audit trail"
```
