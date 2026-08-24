import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
   SupportAssistanceSuggestionItem,
   SupportEnablementPreviewPanel,
   SupportKnowledgeUseHistory,
} from './support-case-maturity';
import {
   SupportKnowledgeGapItem,
   SupportProblemClusterDetail,
   SupportQualityReviewItem,
} from './support-maturity-view';
import type {
   SupportAssistanceSuggestion,
   SupportEnablementPreview,
   SupportKnowledgeGap,
   SupportKnowledgeUse,
   SupportProblemCluster,
   SupportQualityReview,
} from '@/lib/support-maturity-types';

describe('Support Phase 8 maturity views', () => {
   test('shows suggestion provenance and requires an explicit human decision', () => {
      const html = renderToStaticMarkup(
         <SupportAssistanceSuggestionItem
            busy={false}
            item={suggestion()}
            reason="بررسی انسانی انجام شد"
            onReason={() => undefined}
            onDecide={() => undefined}
         />
      );
      expect(html).toContain('پیشنهاد اولویت');
      expect(html).toContain('rules / impact-urgency / v3');
      expect(html).toContain('۹۱٪');
      expect(html).toContain('اثر انگشت زمینه');
      expect(html).toContain('پذیرش انسانی');
      expect(html).toContain('رد پیشنهاد');
      expect(html).not.toContain('private-case-context');
   });

   test('renders an exact reversible preview and never presents it as automatic execution', () => {
      const html = renderToStaticMarkup(
         <SupportEnablementPreviewPanel
            busy={false}
            preview={preview()}
            onApply={() => undefined}
            onClear={() => undefined}
         />
      );
      expect(html).toContain('پیش‌نمایش دقیق تغییرات');
      expect(html).toContain('اولویت');
      expect(html).toContain('عادی');
      expect(html).toContain('فوری');
      expect(html).toContain('فقط با تأیید انسان اعمال می‌شود');
      expect(html).toContain('اعمال تغییرات پیش‌نمایش‌شده');
   });

   test('keeps KCS history to independently authorized page metadata and outcome evidence', () => {
      const html = renderToStaticMarkup(<SupportKnowledgeUseHistory items={[knowledgeUse()]} />);
      expect(html).toContain('راهنمای بازپرداخت');
      expect(html).toContain('مفید');
      expect(html).toContain('پرونده حل شد');
      expect(html).toContain('نسخه ۷');
      expect(html).not.toContain('customer-private-copy');
   });

   test('labels cluster counts as visible-only and renders only authorized Case links', () => {
      const html = renderToStaticMarkup(
         <SupportProblemClusterDetail
            cluster={cluster()}
            busyCaseKey=""
            onStatus={() => undefined}
            onUnlink={() => undefined}
         />
      );
      expect(html).toContain('۱ پرونده قابل مشاهده');
      expect(html).toContain('SUP-1');
      expect(html).toContain('پرونده مجاز');
      expect(html).toContain('تعداد و پیوندها فقط از پرونده‌های مجاز شما محاسبه شده‌اند');
      expect(html).not.toContain('peer-secret');
   });

   test('renders Knowledge review ownership/status and privacy-scoped quality results without rankings', () => {
      const gapHtml = renderToStaticMarkup(
         <SupportKnowledgeGapItem
            busy={false}
            item={knowledgeGap()}
            users={[{ id: 'manager', name: 'مدیر دانش' }]}
            onUpdate={() => undefined}
         />
      );
      const reviewHtml = renderToStaticMarkup(<SupportQualityReviewItem item={qualityReview()} />);
      expect(gapHtml).toContain('مقاله نادرست');
      expect(gapHtml).toContain('در حال بررسی');
      expect(gapHtml).toContain('مدیر دانش');
      expect(reviewHtml).toContain('۸۴ از ۱۰۰');
      expect(reviewHtml).toContain('کارشناس مجاز');
      expect(reviewHtml).toContain('نتیجه ارزیابی فردی مجاز');
      expect(reviewHtml).not.toContain('رتبه‌بندی');
      expect(reviewHtml).not.toContain('peer-secret');
   });
});

function suggestion(): SupportAssistanceSuggestion {
   return {
      id: 'suggestion', caseId: 'case', kind: 'PRIORITY', payload: { priority: 'URGENT' },
      provenance: {
         provider: 'rules', modelOrRule: 'impact-urgency', version: '3', confidence: 0.91,
         contextDigest: 'a'.repeat(64),
      },
      decision: 'PENDING', decisionReason: null, decisionCaseVersion: null,
      decidedAt: null, expiresAt: null, createdAt: '2026-08-23T10:00:00.000Z',
   };
}

function preview(): SupportEnablementPreview {
   return {
      definition: {
         id: 'definition', kind: 'MACRO', definitionKey: 'urgent', version: 2, name: 'فوری‌سازی',
         description: null, status: 'APPROVED', conditions: null,
         actions: [{ type: 'SET_PRIORITY', value: 'URGENT' }], createdById: 'owner', approvedById: 'owner',
         approvedAt: '2026-08-23T10:00:00.000Z', retiredById: null, retiredAt: null,
         createdAt: '2026-08-23T09:00:00.000Z',
      },
      case: { id: 'case', key: 'SUP-1', version: 3 }, conditionMatched: true, conditionResults: [],
      changes: [{ field: 'priority', before: 'NORMAL', after: 'URGENT' }], previewHash: 'a'.repeat(64),
      canApply: true, requiresHumanApply: true,
   };
}

function knowledgeUse(): SupportKnowledgeUse {
   return {
      id: 'use', caseId: 'case', knowledgePageId: 'page', caseVersion: 3, knowledgePageVersion: 7,
      usefulness: 'HELPFUL', outcome: 'RESOLVED', createdById: 'agent',
      createdAt: '2026-08-23T10:00:00.000Z',
      page: { id: 'page', title: 'راهنمای بازپرداخت', version: 7, status: 'PUBLISHED' },
   };
}

function cluster(): SupportProblemCluster {
   return {
      id: 'cluster', title: 'مشکل ورود', summary: 'خلاصه پاک‌سازی‌شده', status: 'OPEN', version: 2,
      createdById: 'manager', createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-23T10:00:00.000Z', visibleMemberCount: 1, accessEpoch: '2',
      cases: [{
         id: 'case', key: 'SUP-1', title: 'پرونده مجاز', status: 'OPEN', priority: 'HIGH',
         departmentId: 'department', assigneeMembershipId: null, version: 4,
         updatedAt: '2026-08-23T10:00:00.000Z', linkedAt: '2026-08-22T10:00:00.000Z',
      }],
   };
}

function knowledgeGap(): SupportKnowledgeGap {
   return {
      id: 'gap', caseId: 'case', knowledgePageId: 'page', kind: 'WRONG', status: 'IN_REVIEW',
      feedback: 'مراحل قدیمی هستند', reviewOwnerId: 'manager', createdById: 'agent', resolvedAt: null,
      version: 2, createdAt: '2026-08-22T10:00:00.000Z', updatedAt: '2026-08-23T10:00:00.000Z',
      case: { id: 'case', key: 'SUP-1', title: 'پرونده مجاز', version: 4 },
      page: { id: 'page', title: 'راهنمای قدیمی', version: 2, status: 'PUBLISHED' },
   };
}

function qualityReview(): SupportQualityReview {
   return {
      id: 'review', caseId: 'case', rubricId: 'rubric', rubricVersion: 2, departmentId: 'department',
      assigneeUserId: 'agent', reviewerId: 'manager', reviewerKind: 'HUMAN', sampleReason: 'نمونه حل‌شده',
      score: 84, findings: [{ criterionKey: 'accuracy', score: 4, finding: 'دقیق' }],
      completedAt: '2026-08-23T10:00:00.000Z', createdAt: '2026-08-23T10:00:00.000Z',
      case: { id: 'case', key: 'SUP-1', title: 'پرونده مجاز' },
      rubric: { id: 'rubric', rubricKey: 'standard', name: 'استاندارد', version: 2 },
      reviewer: { id: 'manager', name: 'مدیر مجاز' }, assignee: { id: 'agent', name: 'کارشناس مجاز' },
   };
}
