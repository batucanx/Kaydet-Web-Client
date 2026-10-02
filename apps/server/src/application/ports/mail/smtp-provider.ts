import type { AuthorizedAccount } from '../../context/authorized-account.ts';
import type { OutgoingMessage } from './sender.ts';

export interface SmtpSendResult {
  readonly messageId: string | null;
  readonly envelope: {
    readonly from: string;
    readonly to: readonly string[];
  };
}

export interface SmtpProvider {
  /**
   * Tests connectivity, TLS handshake, and authentication against the SMTP provider.
   */
  testConnection(account: AuthorizedAccount): Promise<void>;

  /**
   * Sends an outgoing message through SMTP.
   * Enforces that Bcc recipients are present in envelope RCPT TO but stripped from message headers.
   */
  send(message: OutgoingMessage): Promise<SmtpSendResult>;
}
