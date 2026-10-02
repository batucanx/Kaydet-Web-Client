import {
  Archive,
  Download,
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  Music,
  Paperclip,
  ShieldAlert,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  attachmentTypeLabel,
  classifyAttachment,
  formatBytes,
} from '@kaydet/domain';
import type { AttachmentDTO, AttachmentKind } from '@kaydet/domain';
import styles from './MailAttachments.module.css';

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

export interface MailAttachmentsProps {
  messageId: string;
  attachments: AttachmentDTO[];
}

export function MailAttachments({ messageId, attachments }: MailAttachmentsProps) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <section className={styles.attachmentSection} aria-label="Ekler">
      <div className={styles.heading}>
        <Paperclip size={14} aria-hidden="true" />
        <span>Ekler ({attachments.length})</span>
      </div>
      <ul className={styles.attachmentList}>
        {attachments.map((att) => {
          const kind = classifyAttachment({ mimeType: att.mimeType, fileName: att.fileName });
          const Icon = KIND_ICONS[kind] ?? File;
          const typeLabel = attachmentTypeLabel(att.fileName);
          const sizeText = formatBytes(att.sizeBytes);
          const downloadUrl = `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.id)}?download=1`;

          return (
            <li key={att.id} className={styles.attachmentItem}>
              <a
                href={downloadUrl}
                download={att.fileName}
                className={styles.attachmentCard}
                title={`${att.fileName} (${sizeText}) - İndirmek için tıklayın`}
              >
                <span className={styles.iconWrap}>
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span className={styles.infoWrap}>
                  <span className={styles.fileName}>{att.fileName}</span>
                  <span className={styles.fileMeta}>
                    <span className={styles.badge}>{typeLabel}</span>
                    <span>{sizeText}</span>
                  </span>
                </span>
                <Download size={16} className={styles.downloadIcon} aria-hidden="true" />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
