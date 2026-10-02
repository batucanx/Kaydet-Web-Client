import { useEffect, useRef, useState } from 'react';
import type { DraftInputDTO, DraftSourceDTO, EmailAddressDTO } from '@kaydet/domain';
import { putDraft } from '../../data/api/drafts';
import type { ApiClient } from '../../data/api/client';
import { defaultApiClient } from '../../data/api/client';
import { useEvent } from '../../lib/useEvent';

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface UseDraftAutosaveOptions {
  client?: ApiClient;
  accountId: string;
  draftId: string;
  to: EmailAddressDTO[];
  cc: EmailAddressDTO[];
  bcc: EmailAddressDTO[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  attachmentIds: string[];
  source: DraftSourceDTO | null;
  enabled?: boolean;
  debounceMs?: number;
}

export interface UseDraftAutosaveResult {
  status: AutosaveStatus;
  lastSavedAt: Date | null;
  errorMessage: string | null;
  saveNow: () => Promise<boolean>;
}

export function useDraftAutosave({
  client = defaultApiClient,
  accountId,
  draftId,
  to,
  cc,
  bcc,
  subject,
  bodyText,
  bodyHtml,
  attachmentIds,
  source,
  enabled = true,
  debounceMs = 1500,
}: UseDraftAutosaveOptions): UseDraftAutosaveResult {
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Monotonic version counter to protect against race conditions
  const versionRef = useRef(0);
  const lastSavedVersionRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingAfterFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasContent =
    to.length > 0 ||
    cc.length > 0 ||
    bcc.length > 0 ||
    subject.trim().length > 0 ||
    bodyText.trim().length > 0 ||
    attachmentIds.length > 0;

  const latestInputRef = useRef<DraftInputDTO>({
    accountId,
    to,
    cc,
    bcc,
    subject,
    bodyText,
    bodyHtml,
    attachmentIds,
    source,
  });

  // Keep latest payload ref updated outside render
  useEffect(() => {
    latestInputRef.current = {
      accountId,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml,
      attachmentIds,
      source,
    };
  });

  const executeSave = useEvent(async (): Promise<boolean> => {
    if (!enabled || !hasContent) return true;

    if (inFlightRef.current) {
      pendingAfterFlightRef.current = true;
      return false;
    }

    const versionToSave = versionRef.current;
    if (versionToSave <= lastSavedVersionRef.current) {
      return true;
    }

    inFlightRef.current = true;
    setStatus('saving');
    setErrorMessage(null);

    try {
      const payload = latestInputRef.current;
      await putDraft(client, draftId, payload);

      lastSavedVersionRef.current = versionToSave;
      setLastSavedAt(new Date());

      if (versionRef.current > versionToSave) {
        setStatus('idle');
        pendingAfterFlightRef.current = true;
      } else {
        setStatus('saved');
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Taslak kaydedilemedi';
      setStatus('error');
      setErrorMessage(msg);
      return false;
    } finally {
      inFlightRef.current = false;
      if (pendingAfterFlightRef.current) {
        pendingAfterFlightRef.current = false;
        void executeSave();
      }
    }
  });

  // Trigger debounced autosave on edits
  useEffect(() => {
    if (!enabled || !hasContent) return;

    versionRef.current += 1;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      void executeSave();
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [
    accountId,
    to,
    cc,
    bcc,
    subject,
    bodyText,
    bodyHtml,
    attachmentIds,
    source,
    enabled,
    hasContent,
    debounceMs,
    executeSave,
  ]);

  const saveNow = useEvent(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    return executeSave();
  });

  return {
    status,
    lastSavedAt,
    errorMessage,
    saveNow,
  };
}
