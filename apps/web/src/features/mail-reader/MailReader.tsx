import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Forward, RefreshCw, Reply, ReplyAll, ServerCrash } from 'lucide-react';
import { useMailActions, useMessageDetail } from '../../data/MailDataContext';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import type { ActionId } from '../mail-list/actions';
import { EmailDocument } from './EmailDocument';
import { MailAttachments } from './MailAttachments';
import { MailReaderHeader } from './MailReaderHeader';
import { MailReaderSkeleton } from './MailReaderSkeleton';
import styles from './MailReader.module.css';

export interface MailReaderProps {
  accountId: string;
  messageId: string;
  onBack: () => void;
  showBack?: boolean;
  folderName?: string;
}

export function MailReader({
  accountId,
  messageId,
  onBack,
  showBack = true,
  folderName,
}: MailReaderProps) {
  const navigate = useNavigate();
  const [fontSize, setFontSize] = useState<number>(16);
  const [, setRetry] = useState<number>(0);

  const messageQ = useMessageDetail(accountId, messageId);
  const actions = useMailActions();

  // Deduplication tracker to avoid repeated mark-read requests
  const markedSeenRef = useRef<Set<string>>(new Set());

  // Mark unread messages as read automatically upon viewing
  useEffect(() => {
    if (messageQ.status === 'ready') {
      const msg = messageQ.data;
      if (!msg.seen && !markedSeenRef.current.has(msg.id)) {
        markedSeenRef.current.add(msg.id);
        actions.setSeen([msg.id], true);
      }
    }
  }, [messageQ, actions]);

  // Update document title with message subject
  useEffect(() => {
    if (messageQ.status === 'ready' && messageQ.data.subject) {
      document.title = `${messageQ.data.subject} · Kaydet`;
    }
  }, [messageQ]);

  const handleAction = (action: ActionId, arg?: string) => {
    if (messageQ.status !== 'ready') return;
    const msg = messageQ.data;

    switch (action) {
      case 'markRead':
        actions.setSeen([msg.id], true);
        break;
      case 'markUnread':
        actions.setSeen([msg.id], false);
        break;
      case 'pin':
        actions.setPinned([msg.id], true);
        break;
      case 'unpin':
        actions.setPinned([msg.id], false);
        break;
      case 'archive':
        actions.archive([msg.id]);
        onBack();
        break;
      case 'delete':
        actions.remove([msg.id]);
        onBack();
        break;
      case 'move':
        if (arg) {
          actions.moveToFolder([msg.id], arg);
          onBack();
        }
        break;
    }
  };

  const handleReply = (replyMode: 'reply' | 'replyAll' | 'forward') => {
    navigate(`/a/${accountId}/compose?mode=${replyMode}&sourceMessageId=${messageId}`);
  };

  if (messageQ.status === 'loading') {
    return <MailReaderSkeleton onBack={onBack} showBack={showBack} />;
  }

  if (messageQ.status === 'error') {
    return (
      <div className={styles.errorStateWrap}>
        <EmptyState
          role="alert"
          icon={ServerCrash}
          title={messageQ.message.includes('bulunamadı') ? 'İleti bulunamadı' : 'İleti yüklenemedi'}
          description={
            messageQ.message.includes('bulunamadı')
              ? 'Bu ileti silinmiş, taşınmış veya başka bir hesaba ait olabilir.'
              : messageQ.message
          }
          action={
            <div className={styles.errorActions}>
              <Button icon={RefreshCw} onClick={() => setRetry((c) => c + 1)}>
                Yeniden dene
              </Button>
              {showBack && (
                <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
                  Geri dön
                </Button>
              )}
            </div>
          }
        />
      </div>
    );
  }

  const message = messageQ.data;
  const isHtmlSanitized = Boolean(message.body.html && message.body.html.sanitized === true);

  return (
    <article className={styles.reader} aria-label={message.subject || 'İleti ayrıntıları'}>
      <MailReaderHeader
        message={message}
        onBack={onBack}
        showBack={showBack}
        fontSize={fontSize}
        onChangeFontSize={setFontSize}
        onAction={handleAction}
        onReply={handleReply}
        folderName={folderName}
      />

      {message.attachments && message.attachments.length > 0 && (
        <MailAttachments messageId={message.id} attachments={message.attachments} />
      )}

      <div className={styles.contentViewport}>
        <EmailDocument
          html={message.body.html?.content ?? null}
          isSanitized={isHtmlSanitized}
          plainTextFallback={message.body.text}
          fontSize={fontSize}
          title={message.subject || 'İleti içeriği'}
        />
      </div>

      {/* Quick Reply Bar at bottom */}
      <footer className={styles.replyBar} role="group" aria-label="Hızlı yanıt işlemleri">
        <Button variant="secondary" icon={Reply} onClick={() => handleReply('reply')}>
          Yanıtla
        </Button>
        <Button variant="secondary" icon={ReplyAll} onClick={() => handleReply('replyAll')}>
          Tümünü yanıtla
        </Button>
        <Button variant="secondary" icon={Forward} onClick={() => handleReply('forward')}>
          İlet
        </Button>
      </footer>
    </article>
  );
}
