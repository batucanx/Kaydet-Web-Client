/**
 * Outgoing mail (SMTP-side), in Kaydet terms. Used by the future outbox processor — never called from an HTTP
 * request: `POST /drafts/:id/send` only queues an outbox operation (it "responds when queued, not when sent").
 * Failures: `AppError` with `recipient_rejected`, `provider_unreachable`, `send_failed`, … (no raw SMTP text).
 */
import type { DraftDTO } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../context/authorized-account.ts';

export interface OutgoingMessage {
  readonly account: AuthorizedAccount;
  /** The draft as validated at send time. The adapter derives `In-Reply-To`/`References` from `draft.source`. */
  readonly draft: DraftDTO;
}

export interface MailSenderPort {
  /** Resolves with the id of the message that now exists (typically in Sent), when the provider tells. */
  send(message: OutgoingMessage): Promise<{ readonly messageId: string | null }>;
}
