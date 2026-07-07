# Communications Merge And Premium UX Plan

## Goal

Merge `اعلان‌ها` and `جلسه‌ها` into one premium communications surface that feels like a fast operational command center, while preserving the different domain behaviors:

- announcements keep drafts, publishing, recipients, read state, polls, and announcement SMS;
- meetings keep scheduling, project context, participants, owners, action items, and meeting SMS;
- old deep links and SMS links continue to work.

The first implementation should merge navigation and UX, not the database models. `Announcement` and `Meeting` already have different lifecycles, permissions, and child records, so forcing them into one table would add risk without improving the user experience.

## Current State

- Web routes are split in `apps/web/src/App.tsx`:
  - `/:orgId/announcements`
  - `/:orgId/announcements/:announcementId`
  - `/:orgId/meetings`
  - `/:orgId/meetings/:meetingId`
- Full-page views are separate:
  - `apps/web/components/taskara/announcements-view.tsx`
  - `apps/web/components/taskara/meetings-view.tsx`
- Both views already use the same basic shell:
  - left list
  - center detail
  - right metadata/action panel on wide screens
  - create dialog
  - SMS confirmation dialog
- Backend APIs are separate:
  - `apps/api/src/routes/announcements.ts`
  - `apps/api/src/routes/meetings.ts`
- Sidebar and command menu expose two separate destinations in:
  - `apps/web/components/layout/sidebar/app-sidebar.tsx`
  - `apps/web/components/layout/main-layout.tsx`
- Farsi copy is split in `apps/web/lib/fa-copy.ts`.

## Product Direction

Use `اعلان‌ها` as the visible product label for the merged page. Keep the technical route and component naming as `communications` so the code can still represent the broader surface that contains announcements, meetings, and future communication objects.

Recommended route shape:

```text
/:orgId/communications
/:orgId/communications/announcements/:announcementId
/:orgId/communications/meetings/:meetingId
```

Keep old routes as aliases:

```text
/:orgId/announcements/:announcementId -> communications announcement detail
/:orgId/meetings/:meetingId -> communications meeting detail
```

Do not hard-redirect immediately if that would break browser history or SMS links. Reuse the same component under both old and new routes first, then decide later whether to redirect.

## Premium UX Shape

The page should feel like a polished inbox-calendar hybrid, not two tabs bolted together.

1. Left index
   - One chronological list for both entity types.
   - Stable rows with icon, type chip, title, one-line preview, date/time, and small status indicators.
   - Segment filters: `همه`, `اعلان‌ها`, `جلسه‌ها`, `خوانده‌نشده`, `برای من`, `پیش‌نویس‌ها`.
   - Search across title/body/description.
   - Optional date grouping: `امروز`, `این هفته`, `قدیمی‌تر`.

2. Center detail
   - One detail shell that swaps entity-specific content.
   - Announcement detail: body, poll voting/results, read state, publish draft flow.
   - Meeting detail: agenda/minutes, project, schedule, participants, action items.
   - Header shows entity type, status, primary date, and loading state without clearing content.

3. Right action rail
   - Shared panels: status, people, SMS, related project, activity counts.
   - Announcement-specific panel: recipients and read state.
   - Meeting-specific panel: participants, owner, project, action items.
   - Primary actions should be short and icon-led: publish, mark read, send SMS, create action tasks.

4. Creation experience
   - Replace two separate plus buttons with one create menu:
     - `اعلان جدید`
     - `جلسه جدید`
   - Use a shared dialog shell with entity-specific fields.
   - Keep announcement poll controls, meeting schedule/project/owner controls, and user multi-selects.

5. Visual polish
   - Keep dense, calm, operational styling.
   - Use consistent row height, icon sizing, type hierarchy, and focus rings.
   - Avoid nested cards and large decorative gradients.
   - Replace dashed empty boxes with refined empty states that include one primary action.
   - Use skeleton rows and detail skeletons instead of clearing the page during refetch.
   - Verify RTL layout, truncation, and long Persian titles on desktop and mobile.

## Phase 1: Extract Shared Communication Primitives

### Implementation

1. Add a local communication item model in the web app:

```ts
type CommunicationKind = 'announcement' | 'meeting';

type CommunicationListItem = {
  kind: CommunicationKind;
  id: string;
  title: string;
  preview: string;
  status: string;
  date: string;
  unread?: boolean;
  audienceCount?: number;
  projectName?: string;
  source: TaskaraAnnouncement | TaskaraMeeting;
};
```

2. Extract shared helpers:
   - date selection and sorting;
   - announcement unread detection;
   - meeting description plain-text extraction;
   - SMS summary formatting;
   - status labels.

3. Extract shared UI atoms:
   - `CommunicationListRow`
   - `CommunicationEmptyState`
   - `CommunicationActionRailPanel`
   - `CommunicationCreateMenu`

### Files

- `apps/web/components/taskara/announcements-view.tsx`
- `apps/web/components/taskara/meetings-view.tsx`
- new `apps/web/components/taskara/communications/*`
- `apps/web/lib/taskara-types.ts`

### Acceptance Criteria

- No user-facing behavior changes yet.
- Existing announcement and meeting pages still work.
- Shared components render both entity types without duplicated row/detail chrome.

## Phase 2: Build The Unified Communications View

### Implementation

1. Create `CommunicationsView`.
2. Fetch existing endpoints in parallel:
   - `/announcements?limit=100`
   - `/meetings?limit=100`
   - `/users?limit=200`
   - `/projects`
3. Normalize announcements and meetings into one sorted list.
4. Select detail from URL:
   - `communications/announcements/:announcementId`
   - `communications/meetings/:meetingId`
5. Load full detail from the existing detail endpoint when selected.
6. Preserve visible list and selected detail during background refresh.

### Files

- `apps/web/components/taskara/communications-view.tsx`
- `apps/web/src/App.tsx`
- `apps/web/lib/fa-copy.ts`

### Acceptance Criteria

- One page shows announcements and meetings together.
- Filtering by type does not lose selection unless the selected item is outside the filter.
- Deep links select the correct item.
- Creating either entity inserts it into the unified list and navigates to the new detail.
- Existing live refresh still updates announcement and meeting changes.

## Phase 3: Replace Navigation Without Breaking Links

### Implementation

1. Add `fa.nav.communications = 'اعلان‌ها'` and `fa.pages.communicationsDescription`.
2. Replace the two sidebar items with one communications item.
3. Count badge should combine useful attention:
   - unread announcements;
   - relevant meetings count, preferably `mine=true`;
   - later, split visual count by type if needed.
4. Replace command menu entries:
   - `go-announcements` and `go-meetings` become `go-communications`;
   - optionally keep hidden aliases so search terms still find the page.
5. Keep old route aliases in `App.tsx`.
6. Update SMS URL builders later only after route aliases are verified.

### Files

- `apps/web/components/layout/sidebar/app-sidebar.tsx`
- `apps/web/components/layout/main-layout.tsx`
- `apps/web/src/App.tsx`
- `apps/web/lib/fa-copy.ts`
- `apps/api/src/services/announcements.ts`
- `apps/api/src/services/meetings.ts`

### Acceptance Criteria

- Sidebar shows one premium communications destination.
- Command menu opens the new page.
- Old announcement and meeting URLs still open the correct detail.
- SMS links sent before the change still work.

## Phase 4: Make The Detail Experience Premium

### Implementation

1. Replace plain body rendering with a shared readable content container.
2. For announcements:
   - keep poll voting inline;
   - show recipient read state in a tighter, searchable rail;
   - make draft publishing feel like a primary workflow, not an afterthought.
3. For meetings:
   - show agenda/minutes with rich description rendering where available;
   - surface project and owner near the title;
   - show action items in the center detail, not only a side property;
   - expose `ساخت کار از جلسه` as a clear primary action when action items exist.
4. Add keyboard behavior:
   - up/down moves list selection;
   - enter opens/keeps detail;
   - `/` focuses search;
   - `n` opens create menu if this matches existing app shortcuts.
5. Add mobile behavior:
   - list-first on mobile;
   - selecting an item pushes into detail;
   - back returns to the list without losing scroll.

### Files

- `apps/web/components/taskara/communications-view.tsx`
- `apps/web/components/taskara/announcements-view.tsx`
- `apps/web/components/taskara/meetings-view.tsx`
- `apps/web/components/taskara/description-editor.tsx` if rich read-only rendering needs reuse

### Acceptance Criteria

- Detail content never blanks during detail reload.
- Action hierarchy is obvious per entity type.
- Long titles, long recipient names, and long Persian text do not overflow.
- Mobile and desktop both have coherent navigation.

## Phase 5: Add A Backend Aggregate Endpoint If Needed

Do this only after the frontend merge proves the interaction model. The parallel-fetch approach is acceptable for the first release, but it cannot provide perfect cross-entity pagination once workspaces have many records.

### Implementation

1. Add a read-only endpoint:

```text
GET /communications?q=&kind=&status=&mine=&unread=&limit=&offset=
```

2. Internally query announcements and meetings with their current access rules.
3. Return normalized summaries:

```ts
type CommunicationsResponse = {
  items: CommunicationListItem[];
  total: number;
  unreadAnnouncementCount: number;
  meetingCount: number;
  limit: number;
  offset: number;
};
```

4. Keep detail and mutation endpoints entity-specific.
5. Add route tests for access rules, filtering, unread, and mixed sorting.

### Files

- `apps/api/src/routes/communications.ts`
- `apps/api/src/app.ts`
- `packages/shared/src/index.ts`
- `apps/api/src/routes/announcements.ts`
- `apps/api/src/routes/meetings.ts`
- `apps/web/lib/taskara-types.ts`

### Acceptance Criteria

- Unified list pagination is correct across both entity types.
- Search spans announcement title/body and meeting title/description.
- Non-admin users only see records allowed by existing announcement and meeting rules.
- Existing entity routes remain the source of truth for detail and mutations.

## Phase 6: Verification

### Automated

- Web typecheck.
- API typecheck if Phase 5 is implemented.
- Existing announcement and meeting service/route tests.
- New API route tests if `/communications` is added.
- Playwright smoke for:
  - unified page loads;
  - selecting announcement detail;
  - selecting meeting detail;
  - old deep links;
  - create announcement;
  - create meeting;
  - mobile list/detail navigation.

### Manual UX QA

- RTL alignment across list, detail, dialogs, and side rail.
- Long Persian titles and names.
- Empty state for no communications.
- Loading state during refresh.
- Poll voting.
- Draft announcement publishing.
- Meeting SMS.
- Announcement SMS.
- Old SMS URL compatibility.

## Rollout Order

1. Extract shared UI and helpers with no behavior change.
2. Ship `CommunicationsView` behind routes while old nav still exists.
3. Switch sidebar and command menu to the unified destination.
4. Polish detail, mobile, empty, loading, and keyboard states.
5. Add backend aggregate endpoint only when needed for pagination/search scale.
6. Update SMS link generation after route aliases have been verified in production.

## Non-Goals

- Do not merge `Announcement` and `Meeting` Prisma models in the first release.
- Do not remove old routes until SMS links, bookmarks, and notification links have had a deprecation window.
- Do not redesign inbox in this pass, even though inbox already previews both entity types.
- Do not invent a generic `Communication` mutation API yet; mutations should stay entity-specific.
