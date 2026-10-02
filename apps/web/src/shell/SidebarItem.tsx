import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import type { To } from 'react-router-dom';
import { iconSize } from '@kaydet/tokens';
import styles from './SidebarItem.module.css';

interface SidebarItemProps {
  to: To;
  icon: LucideIcon;
  label: string;
  /** Unread (or pinned) count. Hidden when 0/undefined. */
  badge?: number;
  /** Tree depth; each level indents 16 px (mobile: `Space.lg` per level). */
  depth?: number;
  /** Icon-only presentation (tablet rail). */
  compact?: boolean;
  /** Present when the folder has children. */
  expandable?: { expanded: boolean; onToggle: () => void };
  onNavigate?: () => void;
}

/**
 * One folder row. mobile `_FolderTile`: selected = accentSubtle background + 3 px accent bar +
 * accent icon + semibold text; unread badge is a small pill. Current page is exposed via
 * `aria-current="page"` (NavLink), never by color alone.
 */
export function SidebarItem({ to, icon: Icon, label, badge, depth = 0, compact, expandable, onNavigate }: SidebarItemProps) {
  const count = badge && badge > 0 ? badge : 0;
  const countLabel = count > 0 ? `, ${count} okunmamış` : '';
  return (
    <li className={styles.row} data-compact={compact ? '' : undefined}>
      <NavLink
        to={to}
        className={styles.link}
        style={{ paddingLeft: compact ? undefined : `calc(var(--space-lg) + ${depth} * var(--space-lg))` }}
        aria-label={compact ? `${label}${countLabel}` : undefined}
        title={compact ? label : undefined}
        onClick={onNavigate}
      >
        <Icon size={iconSize.md} className={styles.icon} aria-hidden="true" />
        {!compact && <span className={styles.label}>{label}</span>}
        {count > 0 && (
          <span className={styles.badge} aria-hidden={compact ? true : undefined}>
            {count > 999 ? '999+' : count}
          </span>
        )}
      </NavLink>
      {expandable && !compact && (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expandable.expanded}
          aria-label={`${label} alt klasörlerini ${expandable.expanded ? 'daralt' : 'genişlet'}`}
          onClick={expandable.onToggle}
        >
          <ChevronRight size={iconSize.sm} className={styles.chevron} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}
