import { useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Forward,
  Mail,
  MailOpen,
  Pin,
  PinOff,
  Reply,
  ReplyAll,
  Trash2,
  X,
} from 'lucide-react';
import { addressDisplay, formatAddress, formatDetailDate } from '@kaydet/domain';
import type { EmailAddressDTO, MessageDTO } from '@kaydet/domain';
import { formatFullDate } from '../../lib/dates';
import { Avatar } from '../../ui/Avatar';
import { IconButton } from '../../ui/IconButton';
import type { ActionId } from '../mail-list/actions';
import styles from './MailReaderHeader.module.css';

export interface MailReaderHeaderProps {
  message: MessageDTO;
  onBack: () => void;
  showBack?: boolean;
  fontSize: number;
  onChangeFontSize: (size: number) => void;
  onAction: (action: ActionId, arg?: string) => void;
  onReply?: (mode: 'reply' | 'replyAll' | 'forward') => void;
  folderName?: string;
}

const MIN_FONT_SIZE = 13;
const MAX_FONT_SIZE = 22;
const DEFAULT_FONT_SIZE = 16;

function formatRecipientSummary(to: EmailAddressDTO[]): string {
  if (to.length === 0) return 'Alıcı yok';
  const first = addressDisplay(to[0]);
  if (to.length === 1) return first;
  return `${first} +${to.length - 1}`;
}

export function MailReaderHeader({
  message,
  onBack,
  showBack = true,
  fontSize,
  onChangeFontSize,
  onAction,
  onReply,
  folderName,
}: MailReaderHeaderProps) {
  const [expanded, setExpanded] = useState(false);

  const dateObj = new Date(message.date);
  const detailDate = formatDetailDate(dateObj);
  const fullDate = formatFullDate(dateObj);
  const senderDisplay = addressDisplay(message.from);
  const recipientSummary = formatRecipientSummary(message.to);

  const handleZoomIn = () => {
    if (fontSize < MAX_FONT_SIZE) onChangeFontSize(Math.min(MAX_FONT_SIZE, fontSize + 2));
  };

  const handleZoomOut = () => {
    if (fontSize > MIN_FONT_SIZE) onChangeFontSize(Math.max(MIN_FONT_SIZE, fontSize - 2));
  };

  const handleZoomReset = () => {
    onChangeFontSize(DEFAULT_FONT_SIZE);
  };

  return (
    <header className={styles.header}>
      {/* Top Action Bar */}
      <div className={styles.topBar}>
        <div className={styles.navSection}>
          {showBack && (
            <IconButton
              icon={ArrowLeft}
              label="Geri dön"
              onClick={onBack}
            />
          )}
        </div>

        <div className={styles.actionsSection} role="toolbar" aria-label="İleti işlemleri">
          {/* Zoom / Font Size Controls */}
          <div className={styles.zoomControls} role="group" aria-label="Yazı boyutu">
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={handleZoomOut}
              disabled={fontSize <= MIN_FONT_SIZE}
              aria-label="Yazı boyutunu küçült"
              title="Yazı boyutunu küçült"
            >
              A-
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={handleZoomReset}
              disabled={fontSize === DEFAULT_FONT_SIZE}
              aria-label="Yazı boyutunu sıfırla"
              title="Varsayılan yazı boyutu"
            >
              A
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={handleZoomIn}
              disabled={fontSize >= MAX_FONT_SIZE}
              aria-label="Yazı boyutunu büyüt"
              title="Yazı boyutunu büyüt"
            >
              A+
            </button>
          </div>

          {/* Reply / Reply All / Forward */}
          {onReply && (
            <>
              <IconButton
                icon={Reply}
                label="Yanıtla"
                onClick={() => onReply('reply')}
              />
              <IconButton
                icon={ReplyAll}
                label="Tümünü yanıtla"
                onClick={() => onReply('replyAll')}
              />
              <IconButton
                icon={Forward}
                label="İlet"
                onClick={() => onReply('forward')}
              />
            </>
          )}

          {/* Read / Unread toggle */}
          <IconButton
            icon={message.seen ? Mail : MailOpen}
            label={message.seen ? 'Okunmadı olarak işaretle' : 'Okundu olarak işaretle'}
            onClick={() => onAction(message.seen ? 'markUnread' : 'markRead')}
          />

          {/* Pin / Star toggle */}
          <IconButton
            icon={message.pinned ? PinOff : Pin}
            label={message.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle'}
            onClick={() => onAction(message.pinned ? 'unpin' : 'pin')}
            pressed={message.pinned}
          />

          {/* Archive */}
          <IconButton
            icon={Archive}
            label="Arşivle"
            onClick={() => onAction('archive')}
          />

          {/* Delete */}
          <IconButton
            icon={Trash2}
            label="Sil"
            onClick={() => onAction('delete')}
          />

          {/* Close view on desktop if showBack is false */}
          {!showBack && (
            <IconButton
              icon={X}
              label="Kapat"
              onClick={onBack}
            />
          )}
        </div>
      </div>

      {/* Subject Line */}
      <div className={styles.subjectWrap}>
        <h1 className={styles.subject}>{message.subject || '(Konu yok)'}</h1>
      </div>

      {/* Sender & Recipient Meta Row */}
      <div className={styles.metaRow}>
        <div className={styles.senderCol}>
          <Avatar name={message.from.name} email={message.from.email} size={40} />
          <div className={styles.senderDetails}>
            <div className={styles.senderLine}>
              <span className={styles.senderName}>{senderDisplay}</span>
              <span className={styles.senderEmail}>&lt;{message.from.email}&gt;</span>
            </div>

            <div className={styles.recipientLine}>
              <span>Kime:</span>
              <button
                type="button"
                className={styles.recipientBtn}
                aria-expanded={expanded}
                onClick={() => setExpanded((prev) => !prev)}
              >
                <span>{recipientSummary}</span>
                <ChevronDown
                  size={14}
                  className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </div>

        <div className={styles.dateCol}>
          <time className={styles.dateText} dateTime={message.date} title={fullDate}>
            {detailDate}
          </time>
        </div>
      </div>

      {/* Expandable Recipient Details Card */}
      {expanded && (
        <div className={styles.expandedCard} role="region" aria-label="Ayrıntılı alıcı bilgileri">
          <div className={styles.expandedRow}>
            <span className={styles.expandedLabel}>Kimden:</span>
            <span className={styles.expandedValue}>{formatAddress(message.from)}</span>
          </div>

          <div className={styles.expandedRow}>
            <span className={styles.expandedLabel}>Kime:</span>
            <span className={styles.expandedValue}>
              {message.to.map((t) => formatAddress(t)).join(', ') || 'Belirtilmedi'}
            </span>
          </div>

          {message.cc && message.cc.length > 0 && (
            <div className={styles.expandedRow}>
              <span className={styles.expandedLabel}>Bilgi (CC):</span>
              <span className={styles.expandedValue}>
                {message.cc.map((c) => formatAddress(c)).join(', ')}
              </span>
            </div>
          )}

          {message.bcc && message.bcc.length > 0 && (
            <div className={styles.expandedRow}>
              <span className={styles.expandedLabel}>Gizli (BCC):</span>
              <span className={styles.expandedValue}>
                {message.bcc.map((b) => formatAddress(b)).join(', ')}
              </span>
            </div>
          )}

          <div className={styles.expandedRow}>
            <span className={styles.expandedLabel}>Tarih:</span>
            <span className={styles.expandedValue}>{detailDate}</span>
          </div>

          {folderName && (
            <div className={styles.expandedRow}>
              <span className={styles.expandedLabel}>Klasör:</span>
              <span className={styles.expandedValue}>{folderName}</span>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
