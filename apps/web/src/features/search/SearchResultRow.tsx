import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { Mail, MailOpen, Paperclip, Pin, Trash2 } from 'lucide-react';
import type { SearchResultDTO } from '@kaydet/domain';
import { formatListDate } from '../../lib/dates';
import { Avatar } from '../../ui/Avatar';
import { IconButton } from '../../ui/IconButton';
import styles from './SearchResultRow.module.css';

interface SearchResultRowProps {
  result: SearchResultDTO;
  selected: boolean;
  active: boolean;
  now: Date;
  href: string;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onTogglePin: (id: string) => void;
  onToggleSeen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SearchResultRow({
  result,
  selected,
  active,
  now,
  href,
  onToggleSelect,
  onTogglePin,
  onToggleSeen,
  onDelete,
}: SearchResultRowProps) {
  const { message: m, folder } = result;
  const isUnread = !m.seen;
  const senderName = m.from.name.trim() || m.from.email.trim() || 'Bilinmeyen Gönderen';

  const handleCheckboxClick = (e: MouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onToggleSelect(m.id, e.shiftKey);
  };

  const handleRowClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // If clicking on an action button or checkbox, don't follow link
    if ((e.target as HTMLElement).closest('button, input')) {
      e.preventDefault();
    }
  };

  return (
    <Link
      to={href}
      className={`${styles.row} ${isUnread ? styles.unread : ''} ${selected ? styles.selected : ''} ${active ? styles.active : ''}`}
      onClick={handleRowClick}
      data-message-id={m.id}
    >
      <div className={styles.selectCol}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={selected}
          onChange={() => {}}
          onClick={handleCheckboxClick}
          aria-label={`${senderName} iletisini seç`}
        />
      </div>

      <div className={styles.avatarCol}>
        <Avatar name={m.from.name} email={m.from.email} size={32} />
      </div>

      <div className={styles.contentCol}>
        <div className={styles.headerRow}>
          <div className={styles.senderGroup}>
            <span className={styles.sender}>{senderName}</span>
            <span className={styles.folderBadge} title={`Klasör: ${folder.name}`}>
              {folder.name}
            </span>
          </div>

          <div className={styles.dateGroup}>
            {m.hasAttachments && (
              <span title="Ekli dosya">
                <Paperclip size={13} aria-hidden="true" />
              </span>
            )}
            <span className={styles.date}>{formatListDate(new Date(m.date), now)}</span>
          </div>
        </div>

        <div className={styles.subjectRow}>
          <span className={styles.subject}>{m.subject || '(Konu yok)'}</span>
          {m.preview && (
            <>
              <span className={styles.separator} aria-hidden="true">
                —
              </span>
              <span className={styles.snippet}>{m.preview}</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.actionsCol}>
        <IconButton
          icon={Pin}
          label={m.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle'}
          size="sm"
          className={m.pinned ? styles.pinActive : undefined}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTogglePin(m.id);
          }}
        />
        <IconButton
          icon={m.seen ? Mail : MailOpen}
          label={m.seen ? 'Okunmadı olarak işaretle' : 'Okundu olarak işaretle'}
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSeen(m.id);
          }}
        />
        <IconButton
          icon={Trash2}
          label="Sil"
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(m.id);
          }}
        />
      </div>
    </Link>
  );
}
