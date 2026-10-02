import { Forward, Paperclip, Pin, Reply, Clock, Send, TriangleAlert, Check } from 'lucide-react';
import { memo } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { FolderView, LabelView, MessageSummary, Person } from '../../data/types';
import { formatFullDate, formatListDate } from '../../lib/dates';
import { Avatar } from '../../ui/Avatar';
import { IconButton } from '../../ui/IconButton';
import { LabelChip } from '../../ui/LabelChip';
import { ContextMenu, ContextMenuTrigger, MenuContent } from '../../ui/Menu';
import { RowContextMenuItems } from './ActionMenus';
import { QUICK_ACTION_IDS, availableActions } from './actions';
import type { ActionId, ListContext } from './actions';
import styles from './MailListRow.module.css';

export type RowLayout = 'wide' | 'stacked';

export interface MailListRowProps {
  message: MessageSummary;
  /** Multi-selected (checkbox) — accentSubtle + 3 px bar, as on mobile. */
  selected: boolean;
  /** Currently opened message (URL). Distinct from selection. */
  active: boolean;
  layout: RowLayout;
  ctx: ListContext;
  /** Sent/Drafts show recipients instead of the sender (mobile `isSentFolder`). */
  showRecipients: boolean;
  /** Roving tabindex: exactly one row is in the tab order. */
  tabStop: boolean;
  now: Date;
  /** Link target for opening the message. */
  href: string;
  labels: LabelView[];
  folders: FolderView[];
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onRun: (action: ActionId, id: string, arg?: string) => void;
  onFocusRow: (id: string) => void;
}

const names = (people: Person[]): string[] => people.map((p) => p.name.trim() || p.email).filter(Boolean);

/** mobile `_displayName`. */
function displayName(m: MessageSummary, showRecipients: boolean): string {
  if (showRecipients) {
    const to = names(m.to);
    if (to.length === 0) return 'Alıcı yok';
    return to.length > 1 ? `${to[0]} +${to.length - 1}` : (to[0] ?? 'Alıcı yok');
  }
  return m.from.name.trim() || m.from.email.trim() || 'Bilinmeyen gönderen';
}

const OUTBOX_TEXT = {
  queued: 'Gönderilmeyi bekliyor',
  sending: 'Gönderiliyor…',
  failed: 'Gönderilemedi',
  sent: 'Gönderildi',
} as const;

function OutboxBadge({ message }: { message: MessageSummary }) {
  const { state, error } = message.outbox;
  if (state === 'none' || state === 'sent') return null;
  const Icon = state === 'queued' ? Clock : state === 'sending' ? Send : state === 'failed' ? TriangleAlert : Check;
  return (
    <span className={`${styles.outbox} ${styles[state]}`}>
      <Icon size={12} aria-hidden="true" />
      {state === 'failed' ? (error ?? OUTBOX_TEXT.failed) : OUTBOX_TEXT[state]}
    </span>
  );
}

function MailListRowImpl({
  message: m,
  selected,
  active,
  layout,
  ctx,
  showRecipients,
  tabStop,
  now,
  href,
  labels,
  folders,
  onToggleSelect,
  onRun,
  onFocusRow,
}: MailListRowProps) {
  const unread = !m.seen;
  const date = new Date(m.date);
  const name = displayName(m, showRecipients);
  const avatarPerson = showRecipients ? (m.to[0] ?? m.from) : m.from;
  const subject = m.subject.trim() || '(konu yok)';
  const dateText = formatListDate(date, now);
  const tone = (label: string): number => labels.find((l) => l.name === label)?.tone ?? 0;

  const allActions = availableActions(ctx, [m]);
  const quick = allActions.filter((a) => QUICK_ACTION_IDS.includes(a.id));
  const summary =
    `${unread ? 'Okunmamış. ' : ''}${m.pinned ? 'Sabitlenmiş. ' : ''}${m.hasAttachments ? 'Ekli. ' : ''}` +
    `${name}. ${subject}. ${dateText}`;

  const onSelectClick = (event: MouseEvent) => onToggleSelect(m.id, event.shiftKey);

  const onLinkKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    // Space / x toggle selection (Space would otherwise scroll on a link).
    if (event.key === ' ' || event.key.toLowerCase() === 'x') {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      onToggleSelect(m.id, event.shiftKey);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={styles.row}
          data-layout={layout}
          data-unread={unread ? '' : undefined}
          data-pinned={m.pinned ? '' : undefined}
          data-selected={selected ? '' : undefined}
          data-active={active ? '' : undefined}
          data-row-id={m.id}
        >
          {unread && <span className={styles.dot} aria-hidden="true" />}

          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`${selected ? 'Seçimi kaldır' : 'Seç'}: ${name}, ${subject}`}
            className={styles.select}
            tabIndex={tabStop ? 0 : -1}
            onClick={onSelectClick}
          >
            <Avatar name={avatarPerson.name} email={avatarPerson.email} selected={selected} />
          </button>

          <Link
            to={href}
            className={styles.link}
            aria-label={summary}
            aria-current={active ? 'true' : undefined}
            tabIndex={tabStop ? 0 : -1}
            data-row-link=""
            onFocus={() => onFocusRow(m.id)}
            onKeyDown={onLinkKeyDown}
          >
            <span className={styles.sender}>{name}</span>
            <span className={styles.content}>
              <span className={styles.subject}>
                {m.answered && <Reply size={14} className={styles.status} aria-hidden="true" />}
                {m.forwarded && <Forward size={14} className={styles.status} aria-hidden="true" />}
                {subject}
              </span>
              {m.preview && <span className={styles.preview}>{m.preview}</span>}
            </span>
            <OutboxBadge message={m} />
            {m.labels.length > 0 && (
              <span className={styles.labels}>
                {m.labels.slice(0, 3).map((label) => (
                  <LabelChip key={label} name={label} tone={tone(label)} />
                ))}
              </span>
            )}
          </Link>

          <div className={styles.meta}>
            <time className={styles.date} dateTime={m.date} title={formatFullDate(date)}>
              {dateText}
            </time>
            {(m.hasAttachments || m.pinned) && (
              <span className={styles.icons}>
                {m.hasAttachments && <Paperclip size={14} aria-hidden="true" className={styles.iconMuted} />}
                {m.pinned && <Pin size={14} aria-hidden="true" className={styles.iconPin} />}
              </span>
            )}
          </div>

          {/* Hover / focus actions — desktop replacement for mobile swipe. Wide layout only. */}
          <div className={styles.quick} role="group" aria-label="Hızlı eylemler">
            {quick.map((a) => (
              <IconButton
                key={a.id}
                icon={a.icon}
                label={a.label}
                size="sm"
                tone={a.danger ? 'danger' : 'default'}
                tabIndex={tabStop ? 0 : -1}
                onClick={() => onRun(a.id, m.id)}
              />
            ))}
          </div>
        </li>
      </ContextMenuTrigger>
      <MenuContent variant="context">
        <RowContextMenuItems
          actions={allActions}
          folders={folders}
          labels={labels}
          currentFolderId={m.folderId}
          onRun={(action, arg) => onRun(action, m.id, arg)}
        />
      </MenuContent>
    </ContextMenu>
  );
}

/**
 * Memoized: a row re-renders only when its own props change. All callbacks passed in must be
 * stable (the list owns them). This is what keeps large lists and later virtualization cheap.
 */
export const MailListRow = memo(MailListRowImpl);
