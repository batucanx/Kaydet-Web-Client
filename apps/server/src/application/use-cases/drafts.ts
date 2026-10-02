import { UNDO_SEND_WINDOW_MS, checkBeforeSend } from '@kaydet/domain';
import type { AttachmentDTO, DraftDTO, DraftInputDTO, OutboxCancelResponse, OutboxDTO } from '@kaydet/domain';
import { AppError, defineUseCase } from '../errors.ts';
import type { RequestContext } from '../context/request-context.ts';
import type { UseCaseDeps } from './deps.ts';

/** Key of a draft attachment's bytes in blob storage. Segments are encoded: ids may be client-generated. */
export const draftAttachmentBlobKey = (userId: string, draftId: string, attachmentId: string): string =>
  ['draft-attachments', userId, draftId, attachmentId].map(encodeURIComponent).join('/');

export function createDraftUseCases({
  access,
  drafts,
  outbox,
  messages,
  blobs,
  events,
  clock,
  ids,
  transactions,
}: Pick<UseCaseDeps, 'access' | 'drafts' | 'outbox' | 'messages' | 'blobs' | 'events' | 'clock' | 'ids' | 'transactions'>) {
  /** A send that is queued/in flight/done blocks edits and deletion of the draft. */
  const assertNotSent = async (userId: string, draftId: string): Promise<void> => {
    const operation = await outbox.findByDraft(userId, draftId);
    if (operation !== null && operation.state !== 'failed' && operation.state !== 'none') throw new AppError('draft_already_sent');
  };

  return {
    getDraft: defineUseCase('drafts.get', async (ctx: RequestContext, draftId: string): Promise<DraftDTO> => {
      const userId = access.requireUserId(ctx);
      const draft = await drafts.find(userId, draftId);
      if (draft === null) throw new AppError('draft_not_found');
      await access.authorize(ctx, draft.accountId);
      return draft;
    }),

    putDraft: defineUseCase('drafts.put', async (ctx: RequestContext, draftId: string, input: DraftInputDTO): Promise<DraftDTO> => {
      const account = await access.authorize(ctx, input.accountId);
      // ATOMIC: the "already sent?" check and the write must not be separated by a concurrent send.
      return transactions.run(async () => {
        const existing = await drafts.find(account.userId, draftId);
        if (existing !== null) await assertNotSent(account.userId, draftId);

        // Attachments can only be ones already uploaded to THIS draft.
        const attachments: AttachmentDTO[] = [];
        for (const id of new Set(input.attachmentIds)) {
          const attachment = existing?.attachments.find((a) => a.id === id);
          if (attachment === undefined) throw new AppError('attachment_not_found');
          attachments.push(attachment);
        }
        // The message being answered must be the caller's own (the server derives reply headers from it later).
        if (input.source !== null && !(await messages.locateOwned(account.userId, [input.source.messageId])).has(input.source.messageId)) {
          throw new AppError('message_not_found');
        }

        const draft: DraftDTO = {
          id: draftId,
          accountId: account.id,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          attachments,
          source: input.source,
          messageId: existing?.messageId ?? null,
          updatedAt: clock.now().toISOString(),
        };
        await drafts.save(account.userId, draft);
        return draft;
      });
    }),

    /**
     * Validates, then QUEUES a send (its own outbox id, undo window). Nothing is sent here: delivery belongs to
     * the future outbox processor (`MailSenderPort`).
     */
    sendDraft: defineUseCase('drafts.send', async (ctx: RequestContext, draftId: string): Promise<OutboxDTO> => {
      const userId = access.requireUserId(ctx);
      // ATOMIC and exclusive: two concurrent sends of one draft cannot both pass the "already sent?" check.
      const operation = await transactions.run(async () => {
        const draft = await drafts.find(userId, draftId);
        if (draft === null) throw new AppError('draft_not_found');
        await assertNotSent(userId, draftId);
        const account = await access.authorize(ctx, draft.accountId);

        const { blocker } = checkBeforeSend({
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          bodyText: draft.bodyText,
          hasAttachments: draft.attachments.length > 0,
          isReplyOrForward: draft.source !== null,
        });
        if (blocker?.code === 'no_recipients') throw new AppError('no_recipients');
        if (blocker?.code === 'invalid_address') throw new AppError('invalid_recipient', { recipients: [blocker.address] });

        const now = clock.now();
        const queued: OutboxDTO = {
          id: ids.next(),
          accountId: account.id,
          draftId: draft.id,
          messageId: null,
          state: 'queued',
          cancellableUntil: new Date(now.getTime() + UNDO_SEND_WINDOW_MS).toISOString(),
          error: null,
        };
        await outbox.save(userId, queued);
        return queued;
      });
      events.publish(userId, { type: 'outbox.changed', accountId: operation.accountId, outboxId: operation.id, draftId, state: operation.state }); // after the commit
      return operation;
    }),

    /** Undo send. `cancelled: false` (too late) is a normal outcome, not an error. */
    cancelOutbox: defineUseCase('drafts.cancelSend', async (ctx: RequestContext, outboxId: string): Promise<OutboxCancelResponse> => {
      const userId = access.requireUserId(ctx);
      // ATOMIC: "still cancellable?" and the removal are one step (the future worker may be picking the item up).
      const cancelled = await transactions.run(async () => {
        const operation = await outbox.find(userId, outboxId);
        if (operation === null) throw new AppError('outbox_item_not_found');
        const open = operation.state === 'queued' && operation.cancellableUntil !== null && clock.now().getTime() < Date.parse(operation.cancellableUntil);
        if (!open) return null;
        await outbox.remove(userId, outboxId);
        return operation;
      });
      if (cancelled === null) return { cancelled: false, draft: null };
      events.publish(userId, { type: 'outbox.changed', accountId: cancelled.accountId, outboxId, draftId: cancelled.draftId, state: 'none' });
      return { cancelled: true, draft: await drafts.find(userId, cancelled.draftId) };
    }),

    deleteDraft: defineUseCase('drafts.delete', async (ctx: RequestContext, draftId: string): Promise<void> => {
      const userId = access.requireUserId(ctx);
      // ATOMIC: the draft row (with its recipients and attachment metadata) goes in one step; its files are removed after.
      const draft = await transactions.run(async () => {
        const found = await drafts.find(userId, draftId);
        if (found === null) throw new AppError('draft_not_found');
        await assertNotSent(userId, draftId);
        await drafts.remove(userId, draftId);
        return found;
      });
      for (const attachment of draft.attachments) await blobs.remove(draftAttachmentBlobKey(userId, draftId, attachment.id));
    }),

    /**
     * Deferred: the streaming multipart upload (validation while streaming, type sniffing, blob storage) is the
     * attachment phase. Ownership of the draft is still enforced first.
     */
    uploadDraftAttachment: defineUseCase('drafts.uploadAttachment', async (ctx: RequestContext, draftId: string): Promise<AttachmentDTO> => {
      if ((await drafts.find(access.requireUserId(ctx), draftId)) === null) throw new AppError('draft_not_found');
      throw new AppError('service_unavailable');
    }),

    deleteDraftAttachment: defineUseCase('drafts.deleteAttachment', async (ctx: RequestContext, draftId: string, attachmentId: string): Promise<void> => {
      const userId = access.requireUserId(ctx);
      const draft = await drafts.find(userId, draftId);
      if (draft === null) throw new AppError('draft_not_found');
      if (!draft.attachments.some((a) => a.id === attachmentId)) throw new AppError('attachment_not_found');
      await assertNotSent(userId, draftId);
      await blobs.remove(draftAttachmentBlobKey(userId, draftId, attachmentId));
      await drafts.save(userId, { ...draft, attachments: draft.attachments.filter((a) => a.id !== attachmentId), updatedAt: clock.now().toISOString() });
    }),
  };
}
