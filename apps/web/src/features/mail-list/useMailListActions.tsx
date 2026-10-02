import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useMailActions } from '../../data/MailDataContext';
import type { UndoHandle } from '../../data/types';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useNotice } from '../../ui/Notice';
import { isPermanentDelete } from './actions';
import type { ActionId, ListContext } from './actions';

const UNDO_NOTICE_MS = 5000; // mobile: `_undoNoticeDuration`

const plural = (n: number, one: string, many: (n: number) => string): string => (n === 1 ? one : many(n));

/**
 * Runs list actions against the data port and owns the feedback around them: undo notice,
 * permanent-delete confirmation. Semantics follow mobile `message_actions.dart`:
 * archive/delete/restore/move are undoable, permanent deletion is confirmed and irreversible.
 * The port is a placeholder in this phase; the interaction contract is what is being established.
 */
export function useMailListActions({ ctx, onDone }: { ctx: ListContext; onDone: (ids: string[]) => void }): {
  run: (action: ActionId, ids: string[], arg?: string) => void;
  dialog: ReactNode;
} {
  const actions = useMailActions();
  const { show } = useNotice();
  const [confirming, setConfirming] = useState<string[] | null>(null);

  const undoable = useCallback(
    (handle: UndoHandle | null, message: string) => {
      if (!handle) return;
      show({
        message,
        actionLabel: 'Geri al',
        duration: UNDO_NOTICE_MS,
        onAction: () => {
          void handle.undo().then((ok) => {
            if (!ok) show({ message: 'İşlem geri alınamadı.' });
          });
        },
      });
    },
    [show],
  );

  const run = useCallback(
    (action: ActionId, ids: string[], arg?: string) => {
      if (ids.length === 0) return;
      const n = ids.length;
      switch (action) {
        case 'markRead':
          actions.setSeen(ids, true);
          break;
        case 'markUnread':
          actions.setSeen(ids, false);
          break;
        case 'pin':
          actions.setPinned(ids, true);
          break;
        case 'unpin':
          actions.setPinned(ids, false);
          break;
        case 'archive':
          undoable(actions.archive(ids), plural(n, 'İleti arşivlendi', (c) => `${c} ileti arşivlendi`));
          break;
        case 'restore':
          undoable(
            actions.restoreToInbox(ids),
            plural(n, 'İleti Gelen Kutusuna taşındı', (c) => `${c} ileti Gelen Kutusuna taşındı`),
          );
          break;
        case 'spam':
          undoable(
            actions.markSpam(ids),
            plural(n, 'İleti İstenmeyen klasörüne taşındı', (c) => `${c} ileti İstenmeyen klasörüne taşındı`),
          );
          break;
        case 'move':
          if (arg) undoable(actions.moveToFolder(ids, arg), plural(n, 'İleti taşındı', (c) => `${c} ileti taşındı`));
          break;
        case 'label':
          if (arg) {
            actions.applyLabel(ids, arg);
            show({ message: plural(n, 'Etiket uygulandı', (c) => `Etiket ${c} iletiye uygulandı`) });
          }
          break;
        case 'delete':
          if (isPermanentDelete(ctx)) {
            setConfirming(ids); // irreversible → confirm first
            return;
          }
          undoable(actions.remove(ids), plural(n, 'İleti silindi', (c) => `${c} ileti silindi`));
          break;
      }
      onDone(ids);
    },
    [actions, ctx, onDone, show, undoable],
  );

  const count = confirming?.length ?? 0;
  const isDrafts = ctx === 'drafts';
  // Strings are mobile's (message_actions.dart `confirmDelete`).
  const description = isDrafts
    ? count === 1
      ? 'Bu taslak kalıcı olarak silinecek. Bu işlem geri alınamaz.'
      : `${count} taslak kalıcı olarak silinecek. Bu işlem geri alınamaz.`
    : count === 1
      ? 'Bu ileti sunucudan da kalıcı olarak silinecek. Bu işlem geri alınamaz.'
      : `${count} ileti sunucudan da kalıcı olarak silinecek. Bu işlem geri alınamaz.`;

  const dialog = (
    <ConfirmDialog
      open={confirming !== null}
      title="Kalıcı olarak silinsin mi?"
      description={description}
      confirmLabel="Kalıcı olarak sil"
      destructive
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        if (confirming) {
          actions.deletePermanently(confirming);
          onDone(confirming);
        }
        setConfirming(null);
      }}
    />
  );

  return { run, dialog };
}
