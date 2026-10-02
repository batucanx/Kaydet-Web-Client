import { Skeleton } from '../../ui/Skeleton';
import styles from './MailListSkeleton.module.css';

/** Loading placeholder shaped like a list row (mobile `_ListSkeleton`). */
export function MailListSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div className={styles.root} role="status" aria-busy="true" aria-label="İletiler yükleniyor">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row}>
          <Skeleton width={32} height={32} circle />
          <div className={styles.lines}>
            <Skeleton width={`${28 + ((i * 17) % 22)}%`} height={13} />
            <Skeleton width={`${50 + ((i * 11) % 35)}%`} height={12} />
          </div>
          <Skeleton width={36} height={11} />
        </div>
      ))}
    </div>
  );
}
