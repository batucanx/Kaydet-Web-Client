import {
  Archive,
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  Music,
  Paperclip,
  ShieldAlert,
  Video,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  classifyAttachment,
  formatBytes,
} from '@kaydet/domain';
import type { AttachmentDTO, AttachmentKind } from '@kaydet/domain';
import styles from './AttachmentList.module.css';

const KIND_ICONS: Record<AttachmentKind, LucideIcon> = {
  pdf: FileText,
  image: ImageIcon,
  document: FileText,
  spreadsheet: FileText,
  presentation: FileText,
  archive: Archive,
  text: FileCode,
  audio: Music,
  video: Video,
  executable: ShieldAlert,
  unknown: File,
};

export interface AttachmentListProps {
  attachments: AttachmentDTO[];
  onRemove: (attachmentId: string) => void;
  disabled?: boolean;
}

export function AttachmentList({
  attachments,
  onRemove,
  disabled = false,
}: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <section className={styles.section} aria-label="Ekler">
      <div className={styles.heading}>
        <Paperclip size={14} aria-hidden="true" />
        <span>Ekler ({attachments.length})</span>
      </div>

      <ul className={styles.list}>
        {attachments.map((att) => {
          const kind = classifyAttachment({ mimeType: att.mimeType, fileName: att.fileName });
          const Icon = KIND_ICONS[kind] ?? File;

          return (
            <li key={att.id} className={styles.item}>
              <div className={styles.iconWrap} aria-hidden="true">
                <Icon size={16} />
              </div>
              <div className={styles.details}>
                <span className={styles.fileName} title={att.fileName}>
                  {att.fileName}
                </span>
                <span className={styles.fileSize}>{formatBytes(att.sizeBytes)}</span>
              </div>
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => onRemove(att.id)}
                disabled={disabled}
                aria-label={`Eki kaldır: ${att.fileName}`}
                title="Eki kaldır"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
