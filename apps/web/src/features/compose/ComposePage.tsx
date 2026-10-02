import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Clock,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  attachmentRejection,
  buildComposeStart,
  checkBeforeSend,
  describeAttachmentIssues,
  describeSendBlocker,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from '@kaydet/domain';
import type {
  AttachmentDTO,
  ComposeMode,
  DraftDTO,
  DraftSourceDTO,
  EmailAddressDTO,
  SignatureDTO,
} from '@kaydet/domain';
import {
  cancelOutbox,
  deleteDraft,
  deleteDraftAttachment,
  getDraft,
  sendDraft,
  uploadDraftAttachment,
} from '../../data/api/drafts';
import { listSignatures } from '../../data/api/signatures';
import { getMessage } from '../../data/api/messages';
import { useAccounts } from '../../data/MailDataContext';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { IconButton } from '../../ui/IconButton';
import { useNotice } from '../../ui/Notice';
import { Skeleton } from '../../ui/Skeleton';
import { AttachmentList } from './AttachmentList';
import { ComposeEditor } from './ComposeEditor';
import { RecipientInput } from './RecipientInput';
import {
  extractSignatureIdFromHtml,
  htmlToBodyText,
  renderSignatureHtml,
} from './signatureUtils';
import { useDraftAutosave } from './useDraftAutosave';
import styles from './ComposePage.module.css';

export function ComposePage() {
  const { accountId = '', draftId: routeDraftId } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const accountsQ = useAccounts();
  const { show: showNotice } = useNotice();

  // Stable draftId (route-based or generated)
  const [draftId] = useState<string>(() => routeDraftId ?? crypto.randomUUID());

  // Compose mode and source
  const mode = (searchParams.get('mode') as ComposeMode) || 'new';
  const sourceMessageId = searchParams.get('sourceMessageId');

  // Form states
  const [to, setTo] = useState<EmailAddressDTO[]>([]);
  const [cc, setCc] = useState<EmailAddressDTO[]>([]);
  const [bcc, setBcc] = useState<EmailAddressDTO[]>([]);
  const [showCc, setShowCc] = useState<boolean>(false);
  const [showBcc, setShowBcc] = useState<boolean>(false);
  const [subject, setSubject] = useState<string>('');
  const [bodyText, setBodyText] = useState<string>('');
  const [bodyHtml, setBodyHtml] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AttachmentDTO[]>([]);
  const [source, setSource] = useState<DraftSourceDTO | null>(null);

  // Signatures
  const [signatures, setSignatures] = useState<SignatureDTO[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);

  // UI state
  const [loading, setLoading] = useState<boolean>(true);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Active account
  const activeAccount =
    accountsQ.status === 'ready'
      ? accountsQ.data.find((a) => a.id === accountId) ?? accountsQ.data[0]
      : null;

  // Sync route URL with draftId so browser refresh reloads this exact draft
  useEffect(() => {
    if (!routeDraftId && draftId && accountId) {
      navigate(`/a/${accountId}/compose/${draftId}${location.search}`, { replace: true });
    }
  }, [routeDraftId, draftId, accountId, location.search, navigate]);

  // Initial load
  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      setLoading(true);
      try {
        // 1. Load signatures for account
        let sigs: SignatureDTO[] = [];
        try {
          sigs = await listSignatures(undefined, accountId);
          if (!cancelled) setSignatures(sigs);
        } catch {
          // ignore signature load error
        }

        const defaultSig = sigs.find((s) => s.isDefault);

        // 2. If route has draftId and no mode, try loading existing draft
        if (routeDraftId && mode === 'new' && !sourceMessageId) {
          try {
            const draft: DraftDTO = await getDraft(undefined, routeDraftId);
            if (!cancelled) {
              setTo(draft.to);
              setCc(draft.cc);
              setBcc(draft.bcc);
              if (draft.cc.length > 0) setShowCc(true);
              if (draft.bcc.length > 0) setShowBcc(true);
              setSubject(draft.subject);
              setBodyText(draft.bodyText);
              setBodyHtml(draft.bodyHtml);
              setAttachments(draft.attachments);
              setSource(draft.source);

              // Detect signature from bodyHtml
              const existingSigId = draft.bodyHtml
                ? extractSignatureIdFromHtml(draft.bodyHtml)
                : null;
              setSelectedSignatureId(existingSigId ?? 'none');

              setLoading(false);
              return;
            }
          } catch {
            // draft not found on server or network error; proceed with blank
          }
        }

        // 3. If reply / forward mode with source message
        if (sourceMessageId && mode !== 'new') {
          try {
            const srcMsg = await getMessage(undefined, sourceMessageId);
            if (!cancelled) {
              // Pass empty signature to buildComposeStart so the signature text is not duplicated in the quote
              const start = buildComposeStart({
                mode,
                source: {
                  from: srcMsg.from,
                  to: srcMsg.to,
                  cc: srcMsg.cc,
                  subject: srcMsg.subject,
                  date: new Date(srcMsg.date),
                  bodyText: srcMsg.body.text,
                  bodyHtml: srcMsg.body.html?.content ?? null,
                },
                selfEmail: activeAccount?.email ?? null,
                signature: '',
              });

              setTo(start.to);
              setCc(start.cc);
              if (start.cc.length > 0) setShowCc(true);
              setSubject(start.subject);
              setSource({ messageId: srcMsg.id, mode });

              // Build HTML representation preserving signature formatting/image exactly
              const sigHtml = defaultSig ? renderSignatureHtml(defaultSig) : '';
              const quoteHtml = `<div class="quote-header" style="margin-top: 16px; border-left: 2px solid var(--color-divider); padding-left: 12px; color: var(--color-text-secondary);">${start.bodyText.trimStart().replace(/\n/g, '<br/>')}</div>`;
              const initialHtml = `<p><br></p>${sigHtml}${quoteHtml}`;

              setBodyHtml(initialHtml);
              setBodyText(
                `\n\n${defaultSig ? htmlToBodyText(sigHtml) + '\n\n' : ''}${start.bodyText}`
              );
              if (defaultSig) setSelectedSignatureId(defaultSig.id);
              setLoading(false);
              return;
            }
          } catch {
            // source message error
          }
        }

        // 4. Blank compose
        if (!cancelled) {
          if (defaultSig) {
            const sigHtml = renderSignatureHtml(defaultSig);
            setBodyHtml(`<p><br></p>${sigHtml}`);
            setBodyText(`\n\n${htmlToBodyText(sigHtml)}`);
            setSelectedSignatureId(defaultSig.id);
          } else {
            setBodyHtml('<p><br></p>');
            setBodyText('');
            setSelectedSignatureId(null);
          }
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [accountId, routeDraftId, mode, sourceMessageId, activeAccount?.email]);

  // Set document title
  useEffect(() => {
    const modeTitle =
      mode === 'reply'
        ? 'Yanıtla'
        : mode === 'replyAll'
          ? 'Tümünü Yanıtla'
          : mode === 'forward'
            ? 'İlet'
            : 'Yeni İleti';
    document.title = `${subject ? `${subject} · ` : ''}${modeTitle} · Kaydet`;
  }, [mode, subject]);

  // Autosave
  const attachmentIds = attachments.map((a) => a.id);
  const { status: autosaveStatus, saveNow } = useDraftAutosave({
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
    enabled: !loading && !isSending,
  });

  // Warn on tab close if autosave is currently saving
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (autosaveStatus === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [autosaveStatus]);

  // Attachments upload handler
  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    const rejected: Array<{ code: 'blocked_type' | 'empty' | 'too_large'; fileName: string }> = [];

    // Pre-validation
    let currentTotalBytes = attachments.reduce((acc, a) => acc + a.sizeBytes, 0);

    for (const file of fileList) {
      const issue = attachmentRejection({ fileName: file.name, sizeBytes: file.size });
      if (issue) {
        rejected.push({ code: issue, fileName: file.name });
        continue;
      }
      if (currentTotalBytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        rejected.push({ code: 'too_large', fileName: file.name });
        continue;
      }
      currentTotalBytes += file.size;

      // Attempt upload to server
      try {
        const uploaded = await uploadDraftAttachment(undefined, draftId, file);
        setAttachments((prev) => [...prev, uploaded]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Dosya yükleme başarısız';
        showNotice({ message: `${file.name}: ${msg}` });
      }
    }

    if (rejected.length > 0) {
      const msg = describeAttachmentIssues(rejected);
      if (msg) showNotice({ message: msg });
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveAttachment = (id: string) => {
    deleteDraftAttachment(undefined, draftId, id).catch(() => {});
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // Discard draft
  const handleDiscard = () => {
    setConfirmDialog({
      open: true,
      title: 'Taslağı Sil',
      description: 'Bu taslak kalıcı olarak silinecek. Emin misiniz?',
      confirmLabel: 'Sil',
      onConfirm: async () => {
        try {
          await deleteDraft(undefined, draftId);
          showNotice({ message: 'Taslak silindi' });
        } catch {
          // ignore delete error
        }
        navigate(-1);
      },
    });
  };

  // Close compose
  const handleClose = async () => {
    // If has content, ensure saved
    await saveNow();
    navigate(-1);
  };

  // Send execution
  const executeSend = useCallback(async () => {
    setIsSending(true);
    try {
      // 1. Ensure latest changes are saved to server
      const saved = await saveNow();
      if (!saved) {
        throw new Error('Taslak sunucuya kaydedilemedi. Lütfen bağlantınızı kontrol edin.');
      }

      // 2. Post send request
      const outbox = await sendDraft(undefined, draftId);

      // 3. Show notice and allow undo
      showNotice({
        message: 'İleti gönderiliyor…',
        actionLabel: outbox.cancellableUntil ? 'Geri al' : undefined,
        onAction: outbox.cancellableUntil
          ? async () => {
              try {
                const cancelRes = await cancelOutbox(undefined, outbox.id);
                if (cancelRes.cancelled) {
                  showNotice({ message: 'Gönderme iptal edildi, taslak geri yüklendi.' });
                  navigate(`/a/${accountId}/compose/${draftId}`);
                } else {
                  showNotice({ message: 'Gönderme artık geri alınamaz.' });
                }
              } catch {
                showNotice({ message: 'Geri alma işlemi gerçekleştirilemedi.' });
              }
            }
          : undefined,
      });

      // 4. Return to mail list
      navigate(`/a/${accountId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'İleti gönderilemedi';
      showNotice({ message: msg });
      setIsSending(false);
    }
  }, [accountId, draftId, navigate, saveNow, showNotice]);

  // Pre-send validation
  const handleSendClick = () => {
    const check = checkBeforeSend({
      to,
      cc,
      bcc,
      subject,
      bodyText,
      hasAttachments: attachments.length > 0,
      isReplyOrForward: mode !== 'new',
    });

    // Blocker
    if (check.blocker) {
      showNotice({ message: describeSendBlocker(check.blocker) });
      return;
    }

    // Confirmations in order
    if (check.confirmations.includes('missing_attachment')) {
      setConfirmDialog({
        open: true,
        title: 'Ek Unutulmuş Olabilir',
        description:
          'İletinizde bir ekten bahsediliyor gibi görünüyor, ancak hiçbir dosya eklenmemiş. İletiyi yine de göndermek istiyor musunuz?',
        confirmLabel: 'Yine de Gönder',
        onConfirm: () => {
          setConfirmDialog(null);
          if (check.confirmations.includes('empty_subject')) {
            showEmptySubjectConfirm();
          } else {
            void executeSend();
          }
        },
      });
      return;
    }

    if (check.confirmations.includes('empty_subject')) {
      showEmptySubjectConfirm();
      return;
    }

    void executeSend();
  };

  const showEmptySubjectConfirm = () => {
    setConfirmDialog({
      open: true,
      title: 'Konu Yok',
      description: 'İletiniz konu olmadan gönderilsin mi?',
      confirmLabel: 'Gönder',
      onConfirm: () => {
        setConfirmDialog(null);
        void executeSend();
      },
    });
  };

  if (loading) {
    return (
      <div className={styles.page} aria-busy="true">
        <header className={styles.header}>
          <Skeleton width={120} height={20} />
          <Skeleton width={32} height={32} circle />
        </header>
        <div className={styles.scrollArea}>
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={200} />
        </div>
      </div>
    );
  }

  const titleText =
    mode === 'reply'
      ? 'Yanıtla'
      : mode === 'replyAll'
        ? 'Tümünü Yanıtla'
        : mode === 'forward'
          ? 'İlet'
          : 'Yeni İleti';

  return (
    <div className={styles.page}>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={(e) => void handleFileSelect(e.target.files)}
        aria-hidden="true"
      />

      {/* Top Header */}
      <header className={styles.header}>
        <div className={styles.titleArea}>
          <IconButton icon={ArrowLeft} label="Geri dön" onClick={() => void handleClose()} />
          <h1 className={styles.title}>{titleText}</h1>

          {/* Autosave Status Badge */}
          <span
            className={`${styles.autosaveBadge} ${
              autosaveStatus === 'saving'
                ? styles.autosaveSaving
                : autosaveStatus === 'error'
                  ? styles.autosaveError
                  : ''
            }`}
            role="status"
            aria-live="polite"
          >
            {autosaveStatus === 'saving' && (
              <>
                <Clock size={12} aria-hidden="true" />
                <span>Kaydediliyor…</span>
              </>
            )}
            {autosaveStatus === 'saved' && (
              <>
                <Check size={12} aria-hidden="true" />
                <span>Taslak kaydedildi</span>
              </>
            )}
            {autosaveStatus === 'error' && (
              <>
                <TriangleAlert size={12} aria-hidden="true" />
                <span>Kaydedilemedi</span>
              </>
            )}
          </span>
        </div>

        <div className={styles.headerActions}>
          <IconButton icon={Trash2} label="Taslağı sil" onClick={handleDiscard} />
          <IconButton icon={X} label="Kapat" onClick={() => void handleClose()} />
        </div>
      </header>

      {/* Main Compose Scroll Body */}
      <div className={styles.scrollArea}>
        {/* Recipients */}
        <RecipientInput
          label="Kime:"
          recipients={to}
          onChange={setTo}
          placeholder="Alıcı ekleyin"
          showCcBccToggle={true}
          onToggleCc={() => setShowCc((v) => !v)}
          onToggleBcc={() => setShowBcc((v) => !v)}
          hasCc={showCc}
          hasBcc={showBcc}
        />

        {showCc && (
          <RecipientInput
            label="Bilgi (CC):"
            recipients={cc}
            onChange={setCc}
            placeholder="CC alıcısı ekleyin"
          />
        )}

        {showBcc && (
          <RecipientInput
            label="Gizli (BCC):"
            recipients={bcc}
            onChange={setBcc}
            placeholder="BCC alıcısı ekleyin"
          />
        )}

        {/* Editor (Subject, Formatting Toolbar, Rich Contenteditable Body, Signatures) */}
        <ComposeEditor
          subject={subject}
          onSubjectChange={setSubject}
          bodyText={bodyText}
          bodyHtml={bodyHtml}
          onBodyChange={({ bodyText: text, bodyHtml: html }) => {
            setBodyText(text);
            setBodyHtml(html);
          }}
          signatures={signatures}
          selectedSignatureId={selectedSignatureId}
          onSelectSignature={(sig) => setSelectedSignatureId(sig?.id ?? null)}
          onAttachClick={() => fileInputRef.current?.click()}
          disabled={isSending}
        />

        {/* Attachments list */}
        <AttachmentList
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          disabled={isSending}
        />
      </div>

      {/* Footer Bar */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <Button
            variant="primary"
            icon={Send}
            className={styles.sendBtn}
            onClick={handleSendClick}
            disabled={isSending}
          >
            {isSending ? 'Gönderiliyor…' : 'Gönder'}
          </Button>
        </div>

        <div className={styles.footerRight}>
          <IconButton
            icon={Trash2}
            label="Taslağı sil"
            onClick={handleDiscard}
            disabled={isSending}
          />
        </div>
      </footer>

      {/* Confirmation Dialog */}
      {confirmDialog && (
        <ConfirmDialog
          open={confirmDialog.open}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel ?? 'Onayla'}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}
