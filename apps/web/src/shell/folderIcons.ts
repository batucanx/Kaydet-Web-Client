import { Archive, FileText, Folder, Inbox, OctagonAlert, Send, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FolderRole } from '../data/types';

/** mobile: `folderIcon(SpecialUse)` in message_actions.dart. */
export const folderIcons: Record<FolderRole, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  junk: OctagonAlert,
  archive: Archive,
  custom: Folder,
};
