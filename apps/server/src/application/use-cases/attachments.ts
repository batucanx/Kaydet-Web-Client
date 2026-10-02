import { AppError, defineUseCase } from '../errors.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { UseCaseDeps } from './deps.ts';

export interface AttachmentDownload {
  readonly fileName: string;
  /** The stored/declared type; the HTTP layer decides how it may be rendered (never trusted for inline display). */
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly stream: AsyncIterable<Uint8Array>;
}

/** Key of a received message attachment's bytes in blob storage. Segments are encoded (defence in depth). */
export const messageAttachmentBlobKey = (userId: string, messageId: string, attachmentId: string): string =>
  ['attachments', userId, messageId, attachmentId].map(encodeURIComponent).join('/');

export function createAttachmentUseCases({ access, messages, blobs }: Pick<UseCaseDeps, 'access' | 'messages' | 'blobs'>) {
  return {
    downloadAttachment: defineUseCase('attachments.download', async (ctx: RequestContext, messageId: string, attachmentId: string): Promise<AttachmentDownload> => {
      const userId = access.requireUserId(ctx);
      const message = await messages.findOwned(userId, messageId);
      if (message === null) throw new AppError('message_not_found');
      const attachment = message.attachments.find((a) => a.id === attachmentId);
      if (attachment === undefined) throw new AppError('attachment_not_found');
      const blob = await blobs.open(messageAttachmentBlobKey(userId, messageId, attachmentId));
      if (blob === null) throw new AppError('attachment_not_found');
      return { fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: blob.sizeBytes, stream: blob.stream };
    }),
  };
}
