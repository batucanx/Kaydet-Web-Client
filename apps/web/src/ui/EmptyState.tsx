import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Errors are announced assertively; empty states are static content. */
  role?: 'status' | 'alert';
}

/** mobile: `EmptyState` (44 px icon in textTertiary, titleMedium, bodyMedium description). */
export function EmptyState({ icon: Icon, title, description, action, role }: EmptyStateProps) {
  return (
    <div className={styles.root} role={role}>
      <Icon size={44} strokeWidth={1.5} className={styles.icon} aria-hidden="true" />
      <h2 className={styles.title}>{title}</h2>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
