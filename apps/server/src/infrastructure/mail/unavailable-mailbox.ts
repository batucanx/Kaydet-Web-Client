import { AppError } from '../../application/index.ts';
import type { MailActionResult, MailUndoResult, MailboxPort } from '../../application/index.ts';
import type { FolderDTO } from '@kaydet/domain';

/**
 * Phase 3 wiring of the mailbox port: there is no IMAP adapter yet, so every operation that needs the provider
 * fails with the contract's `service_unavailable`. It does not pretend to talk to a mail server.
 */
export class UnavailableMailbox implements MailboxPort {
  requestSync(): Promise<'started' | 'already_running'> {
    return this.unavailable();
  }
  createFolder(): Promise<FolderDTO> {
    return this.unavailable();
  }
  updateFolder(): Promise<FolderDTO> {
    return this.unavailable();
  }
  deleteFolder(): Promise<void> {
    return this.unavailable();
  }
  applyActions(): Promise<MailActionResult> {
    return this.unavailable();
  }
  undo(): Promise<MailUndoResult> {
    // No operation can have been made undoable, so any token is unknown.
    return Promise.resolve({ restored: false });
  }

  private unavailable<T>(): Promise<T> {
    return Promise.reject(new AppError('service_unavailable'));
  }
}
