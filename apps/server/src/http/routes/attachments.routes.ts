import type { UseCases } from '../../application/index.ts';
import type { RouteRegistrar } from '../route-registry.ts';

export function registerAttachmentRoutes(r: RouteRegistrar, u: UseCases): void {
  r.bind('downloadAttachment', ({ ctx, params }) => u.downloadAttachment(ctx, params.messageId, params.attachmentId));
}
