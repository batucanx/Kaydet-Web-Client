import { ArrowUpDown, Check, ChevronDown, Mail, Paperclip, Pin, Tag, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LabelView, MailFilter, MessageSort } from '../../data/types';
import { isFilterActive } from '../../data/types';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../../ui/Menu';
import styles from './FilterBar.module.css';

interface FilterBarProps {
  filter: MailFilter;
  labels: LabelView[];
  onChange: (patch: Partial<MailFilter>) => void;
  onClear: () => void;
}

/** mobile `_sortLabel`. */
const SORT_LABELS: Record<MessageSort, string> = {
  dateDesc: 'Tarih (yeni önce)',
  dateAsc: 'Tarih (eski önce)',
  senderAZ: 'Gönderene göre (A-Z)',
  subjectAZ: 'Konuya göre (A-Z)',
};
const SORT_ORDER: MessageSort[] = ['dateDesc', 'dateAsc', 'senderAZ', 'subjectAZ'];

function Chip({
  icon: Icon,
  pressed,
  onClick,
  children,
}: {
  icon?: LucideIcon;
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button type="button" className={styles.chip} aria-pressed={pressed} onClick={onClick}>
      {/* Selected is shown by a check + fill + border, never by color alone. */}
      {pressed ? <Check size={14} aria-hidden="true" /> : Icon && <Icon size={14} aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * Filter chips. Only filters the mobile app actually has (MessageFilter): Okunmamış, Sabitlenmiş,
 * Ek dosyalı, Etiket ile, and the four sorts. They are independent toggles (not radio categories).
 * "Tümü" clears the toggles (mobile: label "Tümü"; a chip here because desktop shows them inline).
 */
export function FilterBar({ filter, labels, onChange, onClear }: FilterBarProps) {
  const noToggles = !filter.unread && !filter.pinned && !filter.attachments && filter.label === null;
  const labelActive = filter.label !== null;

  return (
    <div className={styles.bar} role="group" aria-label="Filtreler">
      <div className={styles.chips}>
        <Chip
          pressed={noToggles}
          onClick={() => onChange({ unread: false, pinned: false, attachments: false, label: null })}
        >
          Tümü
        </Chip>
        <Chip icon={Mail} pressed={filter.unread} onClick={() => onChange({ unread: !filter.unread })}>
          Okunmamış
        </Chip>
        <Chip icon={Pin} pressed={filter.pinned} onClick={() => onChange({ pinned: !filter.pinned })}>
          Sabitlenmiş
        </Chip>
        <Chip icon={Paperclip} pressed={filter.attachments} onClick={() => onChange({ attachments: !filter.attachments })}>
          Ek dosyalı
        </Chip>

        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={styles.chip} aria-pressed={labelActive} disabled={labels.length === 0}>
              {labelActive ? <Check size={14} aria-hidden="true" /> : <Tag size={14} aria-hidden="true" />}
              {labelActive ? filter.label : 'Etiket ile'}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuRadioGroup value={filter.label ?? ''} onValueChange={(v) => onChange({ label: v === '' ? null : v })}>
              <MenuRadioItem value="">Tümü</MenuRadioItem>
              {labels.map((l) => (
                <MenuRadioItem key={l.id} value={l.name} icon={Tag}>
                  {l.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>

      <div className={styles.end}>
        {isFilterActive(filter) && (
          <button type="button" className={styles.clear} onClick={onClear}>
            <X size={14} aria-hidden="true" />
            Filtreyi temizle
          </button>
        )}
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className={styles.sort} data-changed={filter.sort !== 'dateDesc' ? '' : undefined}>
              <ArrowUpDown size={14} aria-hidden="true" />
              <span className={styles.sortLabel}>Sırala</span>
              <span className="visually-hidden">: {SORT_LABELS[filter.sort]}</span>
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuRadioGroup value={filter.sort} onValueChange={(v) => onChange({ sort: v as MessageSort })}>
              {SORT_ORDER.map((s) => (
                <MenuRadioItem key={s} value={s}>
                  {SORT_LABELS[s]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}
