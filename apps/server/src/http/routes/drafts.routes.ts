import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerDraftRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('getDraft', ({ ctx, params }) => u.getDraft(ctx, params.draftId));
  r.bind('putDraft', ({ ctx, params, body }) => u.putDraft(ctx, params.draftId, body));
  r.bind('sendDraft', ({ ctx, params }) => u.sendDraft(ctx, params.draftId));
  r.bind('cancelOutbox', ({ ctx, params }) => u.cancelOutbox(ctx, params.outboxId));
  r.bind('deleteDraft', ({ ctx, params }) => u.deleteDraft(ctx, params.draftId));
  r.bind('uploadDraftAttachment', ({ ctx, params }) => u.uploadDraftAttachment(ctx, params.draftId));
  r.bind('deleteDraftAttachment', ({ ctx, params }) => u.deleteDraftAttachment(ctx, params.draftId, params.attachmentId));
}
