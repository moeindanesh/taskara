# Public Support Ticketing Integration Plan

## Goal

Expose Taskara's existing Support Workspace as the ticketing backend for another project's
frontend.

Taskara remains the only source of truth for tickets, messages, metadata, media, transcription,
AI-generated titles, status, assignment, and history. The consuming project receives only a
frontend update. It must not add a database, backend persistence, localStorage, IndexedDB, or an
offline mutation queue.

The public integration is intentionally unauthenticated. Anyone who can reach the integration
endpoints may read or change the configured Support Workspace. This is an explicit product
decision, not an accidental omission.

## Non-goals

- Do not redesign the existing Taskara Support UI.
- Do not add authentication, user accounts, login, or per-customer authorization to the public
  integration.
- Do not persist tickets or message data in the consuming project.
- Do not replace Taskara's existing Support Case model with a second ticket model.
- Do not expose Taskara's database directly.
- Do not put provider credentials in frontend code, git, `plan.md`, tests, fixtures, logs, or API
  responses.

## Existing architecture to reuse

- `packages/db/prisma/schema.prisma` is the database source of truth.
- `packages/shared/src/support.ts` contains Support Case enums and validation schemas.
- `apps/api/src/routes/support.ts` and the Support service modules contain the existing Case
  lifecycle, interactions, assignment, routing, and serialization behavior.
- `apps/api/src/routes/media.ts`, `apps/api/src/services/media.ts`, and
  `apps/api/src/services/media-upload.ts` contain the existing CDN/media conventions.
- `apps/api/src/services/support-intake.ts` and `support-intake-contract.ts` contain useful
  idempotency, receipt, and payload validation patterns, but the public browser integration should
  not bypass the normal Case/interaction source of truth.
- `apps/web` remains unchanged for the consuming project's data storage; only its ticketing UI and
  API client are added.

## Target public API

Create a small integration surface under a clearly separated prefix, for example `/public/support`.
Keep existing authenticated Taskara routes unchanged.

### Read endpoints

- `GET /public/support/cases`
  - Return paginated Cases for the one configured Support Workspace.
  - Support filtering by status, priority, search text, and cursor/page.
  - Return only fields needed by the consuming UI.
- `GET /public/support/cases/:idOrKey`
  - Return Case details, current status/priority, assignment summary, timeline, messages, and
    media references.
- `GET /public/support/media/:id`
  - Return or redirect to a CDN-backed media object according to the existing media policy.

### Write endpoints

- `POST /public/support/cases`
  - Create a Support Case.
  - Text is optional.
  - Accept optional images, voice/audio, console errors, page context, browser/device metadata,
    URL, referrer, and arbitrary structured diagnostic details.
- `POST /public/support/cases/:idOrKey/messages`
  - Add a customer message/interaction.
  - Text, image, and voice/audio are independently optional; any combination is valid, including
    media-only messages.
  - Accept the same optional page/console diagnostic context.
- `PATCH /public/support/cases/:idOrKey`
  - Update the limited public fields needed by the frontend, initially status and any explicitly
    approved customer-facing fields.
- `POST /public/support/cases/:idOrKey/media`
  - Optional separate upload/registration endpoint if multipart uploads cannot be safely included
    in the create/message request.

Every endpoint must use the configured Support Workspace only. The workspace identifier must come
from server configuration, not from an arbitrary client-provided workspace ID.

## Request payload shape

Use JSON for metadata and multipart/form-data for binary uploads, or use a two-step upload flow:

1. Upload media to Taskara.
2. Receive a Taskara media reference.
3. Include that reference in the Case/message JSON request.

A Case/message request should support:

- `text?: string`
- `images?: MediaInput[]`
- `audio?: MediaInput[]`
- `consoleErrors?: ConsoleError[]`
- `pageContext?: { url, title, route, referrer, userAgent, viewport, locale, timezone, ... }`
- `metadata?: Record<string, unknown>`
- `clientRequestId?: string`

Validation rules:

- At least one of text, image, audio, console error, or structured context must be present.
- Enforce size, count, MIME type, and duration limits.
- Reject unknown or oversized payloads with stable validation errors.
- Treat client request IDs as idempotency keys to avoid duplicate Cases/messages after retries.
- Never trust client-supplied title, workspace, ownership, SLA, or internal visibility fields.

## Media/CDN flow

Taskara owns media storage and references.

1. Validate MIME type, byte size, and (for audio) duration.
2. Upload images/audio through Taskara's server-side CDN/S3 integration.
3. Store only the returned object/reference metadata in Taskara.
4. Return CDN URLs or stable media references to the frontend.
5. Keep provider credentials server-side only.
6. Ensure the consuming frontend never uploads directly with long-lived S3 credentials.
7. Add cleanup behavior for abandoned uploads and failed Case/message transactions.

Use existing `TASKARA_CDN_UPLOAD_URL`, `TASKARA_CDN_MEDIA_BASE_URL`, and `TASKARA_CDN_APP`
conventions where possible. If direct S3-compatible storage is required, add server-only
configuration names such as:

- `TASKARA_S3_ACCESS_KEY_ID`
- `TASKARA_S3_SECRET_KEY`
- `TASKARA_S3_ENDPOINT`
- `TASKARA_S3_BUCKET`
- `TASKARA_S3_REGION`

Do not commit their values.

## Voice transcription and AI title generation

Taskara performs all AI work asynchronously or in a bounded request-time job:

1. Accept the Case/message and persist the original audio reference first.
2. Queue transcription/title work so a slow provider cannot lose the ticket.
3. Send audio to a supported transcription path.
4. If the selected OpenRouter model cannot accept the audio format, normalize/transcribe through a
   compatible server-side adapter before calling the model.
5. Generate a concise Case title from text, transcript, console errors, and page context.
6. Persist transcript, title, provider/model metadata, processing status, and error state in
   Taskara.
7. Never overwrite user-authored text.
8. If AI fails, keep the Case/message usable with a deterministic fallback title and an explicit
   processing/error state.

Configuration should be server-only:

- `TASKARA_OPENROUTER_API_KEY`
- `TASKARA_AI_MODEL` (configured to the approved Gemini 3.1 Flash Lite OpenRouter model ID after
  verifying the exact provider identifier)
- `TASKARA_AI_TIMEOUT_MS`
- `TASKARA_AI_MAX_AUDIO_BYTES`
- `TASKARA_AI_MAX_OUTPUT_TOKENS`

The API key pasted in the request must be rotated before implementation and loaded through the
environment/secrets manager. It must never be copied into this repository or reused from chat.

Because OpenRouter does not support every voice/audio format, implement explicit format handling:

- Allow only formats the upload/transcription pipeline can process.
- Convert supported-but-incompatible codecs server-side when practical.
- Return a clear `audio_processing_unavailable` state for unsupported formats.
- Preserve the original audio object even when transcription fails.

## Diagnostic data and logging

For Case creation and every message, accept optional:

- console errors
- recent console warnings
- page URL/title/route
- referrer
- browser/device/viewport/locale/timezone
- client timestamp
- arbitrary structured debugging details

Store diagnostic data as structured JSON in Taskara, with redaction and limits:

- remove authorization headers, cookies, tokens, passwords, and obvious secrets
- cap strings, arrays, nesting depth, and total JSON bytes
- normalize stack traces without losing useful source information
- preserve the raw user message separately from diagnostics

On creation, emit a structured server log containing:

- request/correlation ID
- Case/message ID and key
- configured workspace
- client request ID
- media counts and MIME types
- diagnostic payload size
- AI processing state
- elapsed time
- error code when applicable

Never log raw audio, image bytes, provider keys, bearer tokens, or unredacted sensitive metadata.

## Database changes

Prefer extending existing Support models rather than introducing duplicate ticket tables.

Add only the fields/models required for:

- public integration idempotency
- media references linked to Cases and interactions
- structured diagnostic context
- transcription status/result/error
- AI title status/source/model metadata
- processing attempts and retry timestamps

Use real Prisma migrations. Do not rely on `db:push` for constraints.

Add database constraints/indexes for:

- unique `(workspaceId, clientRequestId)` where appropriate
- Case/message lookup by public reference
- media ownership and lifecycle
- AI job status and retry scheduling

Keep internal Support visibility and audit records intact even though the new public routes are
unauthenticated.

## Frontend update in the consuming project

Only update that project's frontend:

- Add a Taskara API client with the configured public API base URL.
- Add ticket list/queue view.
- Add ticket detail/timeline view.
- Add new ticket form.
- Add reply form supporting text, images, and voice recording/upload.
- Add status controls approved by the public API contract.
- Capture optional console errors and page context.
- Display upload, transcription, title-generation, retry, and failure states.
- Refetch the Case after writes.
- Poll or use a lightweight refresh interval for new messages/status changes if needed.
- Keep all state in memory/component state or server cache only.
- Do not add database tables, backend endpoints, localStorage, IndexedDB, or offline queues.

The frontend must treat Taskara response data as authoritative and must not locally invent a
successful write before the API confirms it.

## Public-access safeguards without authentication

Authentication is intentionally omitted, but implement operational protections:

- CORS allowlist for the consuming frontend origin(s).
- Request body and multipart limits.
- Per-IP and per-route rate limits.
- Idempotency handling.
- Timeouts and bounded retries for CDN/AI providers.
- Correlation IDs and structured error codes.
- Redaction of secrets from diagnostics.
- No stack traces or provider credentials in public responses.
- Explicit environment switch to disable public routes immediately.
- Health/metrics for upload, AI, and public API failures.

Do not describe CORS as authorization. CORS only controls browser behavior; direct HTTP clients
can still call the endpoints by design.

## Implementation order

1. Confirm the consuming project's frontend URL, API base URL, allowed media formats, maximum
   upload sizes, desired public status transitions, and Case list/detail fields.
2. Inventory existing Support Case, interaction, attachment/media, intake, and AI abstractions.
3. Define shared Zod schemas and response DTOs for the public API.
4. Add Prisma migration(s) for idempotency, media links, diagnostics, transcription, and AI title
   processing state.
5. Implement server-side CDN/S3 configuration and media upload lifecycle.
6. Implement public Case/message routes against the existing Support services.
7. Implement diagnostics redaction, structured creation logs, correlation IDs, rate limits, and
   the public-route feature switch.
8. Implement the transcription/title job and fallback behavior.
9. Add targeted API tests for create/list/view/update/message/media/idempotency/error paths.
10. Update only the consuming project's frontend and connect it to the public API.
11. Add frontend integration tests for text-only, image-only, voice-only, mixed, retry, and
    processing-state flows.
12. Run focused checks first, then the repository-required API tests, web tests, and typecheck.
13. Perform a deployment smoke test with sanitized test media and verify no credentials or raw
    media appear in logs.

## Acceptance criteria

- A browser can create a Case with text, image, voice, diagnostics, or any supported combination.
- A browser can add messages with text, image, voice, or any supported combination.
- Text is optional when media or structured diagnostics are present.
- Images and audio are stored through Taskara's CDN/S3 path.
- Voice is transcribed when supported; unsupported formats have a visible non-destructive failure
  state.
- AI generates a useful title when possible, with a deterministic fallback when it fails.
- Original message text and media references remain available after AI processing errors.
- Duplicate client retries do not create duplicate Cases/messages.
- The consuming project stores none of the ticket data persistently.
- Existing internal Support routes and workflows continue to work.
- Public responses contain no secrets, raw provider errors, or unredacted sensitive diagnostics.
- The public route can be disabled through configuration without modifying the consuming frontend.

## Handoff notes for a new chat

Before writing code, the next agent should read this file plus `AGENTS.md`, `CONTEXT.md`,
`README.md`, `packages/db/prisma/schema.prisma`, `packages/shared/src/support.ts`,
`apps/api/src/routes/support.ts`, `apps/api/src/services/support-cases.ts`,
`apps/api/src/services/media-upload.ts`, and `apps/api/src/services/media.ts`.

The next agent should first produce a short implementation checklist and identify the consuming
frontend repository/path. It must not request or commit secrets. Any credentials previously pasted
into chat should be considered exposed and rotated before deployment.
