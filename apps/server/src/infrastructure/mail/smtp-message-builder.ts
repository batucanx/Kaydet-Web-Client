import { formatAddress } from '@kaydet/domain';
import type { DraftDTO } from '@kaydet/domain';
import type { AuthorizedAccount } from '../../application/context/authorized-account.ts';

export interface BuiltSmtpMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Record<string, string>;
  readonly envelope: {
    readonly from: string;
    readonly to: readonly string[];
  };
}

/**
 * Builds email options for SMTP transmission.
 * Ensures Bcc recipients are added to the SMTP envelope but strictly excluded from headers.
 */
export function buildSmtpMail(account: AuthorizedAccount, draft: DraftDTO): BuiltSmtpMail {
  const from = formatAddress({ email: account.email, name: '' });

  const toHeaders = draft.to.map((addr) => formatAddress(addr));
  const ccHeaders = draft.cc.map((addr) => formatAddress(addr));

  // Envelope recipients must include To, Cc, AND Bcc
  const envelopeRecipients: string[] = [
    ...draft.to.map((a) => a.email),
    ...draft.cc.map((a) => a.email),
    ...draft.bcc.map((a) => a.email),
  ];

  const headers: Record<string, string> = {};

  if (draft.source?.messageId) {
    headers['In-Reply-To'] = draft.source.messageId;
    headers['References'] = draft.source.messageId;
  }

  return {
    from,
    to: toHeaders,
    cc: ccHeaders,
    subject: draft.subject,
    text: draft.bodyText,
    html: draft.bodyHtml ?? undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    envelope: {
      from: account.email,
      to: envelopeRecipients,
    },
  };
}
