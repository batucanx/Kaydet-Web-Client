import { ArrowLeft } from 'lucide-react';
import { IconButton } from '../../ui/IconButton';
import { Skeleton } from '../../ui/Skeleton';
import styles from './MailReaderSkeleton.module.css';

export interface MailReaderSkeletonProps {
  onBack?: () => void;
  showBack?: boolean;
}

export function MailReaderSkeleton({ onBack, showBack = false }: MailReaderSkeletonProps) {
  return (
    <div className={styles.skeletonContainer} role="status" aria-label="İleti yükleniyor">
      <div className={styles.topBar}>
        {showBack && onBack ? (
          <IconButton icon={ArrowLeft} label="Geri dön" onClick={onBack} />
        ) : (
          <Skeleton width={80} height={28} />
        )}
        <Skeleton width={160} height={28} />
      </div>

      <div className={styles.subjectLine}>
        <Skeleton width="75%" height={32} />
      </div>

      <div className={styles.senderRow}>
        <Skeleton width={40} height={40} />
        <div className={styles.senderMeta}>
          <Skeleton width={180} height={18} />
          <Skeleton width={120} height={14} />
        </div>
        <Skeleton width={100} height={14} />
      </div>

      <div className={styles.bodyLines}>
        <Skeleton width="100%" height={16} />
        <Skeleton width="94%" height={16} />
        <Skeleton width="98%" height={16} />
        <Skeleton width="88%" height={16} />
        <Skeleton width="60%" height={16} />
      </div>
    </div>
  );
}
