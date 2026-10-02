import { Ellipsis, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { FolderView, LabelView } from '../../data/types';
import { useShell } from '../../shell/ShellContext';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/Menu';
import { FolderMenuItems, LabelMenuItems } from './ActionMenus';
import { actionSpec } from './actions';
import type { ActionId, ActionSpec } from './actions';
import styles from './MailToolbar.module.css';

interface MailToolbarProps {
  title: string;
  selectedCount: number;
  totalCount: number;
  /** Actions valid for the current selection (already resolved by `availableActions`). */
  actions: ActionSpec[];
  folders: FolderView[];
  labels: LabelView[];
  currentFolderId: string;
  onToggleAll: () => void;
  onClear: () => void;
  onRun: (action: ActionId, arg?: string) => void;
}

/**
 * List toolbar. Idle: select-all + folder title. With a selection it becomes the contextual
 * action bar (mobile `_SelectionActionBar`: Sil, Arşivle, Taşı, Etiket) plus the remaining
 * supported actions under "Diğer". Text labels on wide layouts, icon-only when space is tight.
 */
export function MailToolbar({
  title,
  selectedCount,
  totalCount,
  actions,
  folders,
  labels,
  currentFolderId,
  onToggleAll,
  onClear,
  onRun,
}: MailToolbarProps) {
  const { mode } = useShell();
  const showText = mode === 'laptop' || mode === 'desktop' || mode === 'wide';
  const checkbox = useRef<HTMLInputElement>(null);
  const has = selectedCount > 0;
  const all = has && selectedCount === totalCount;

  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = has && !all;
  }, [has, all]);

  const byId = (id: ActionId): ActionSpec | undefined => actions.find((a) => a.id === id);
  const primary = (['archive', 'restore', 'delete'] as const).map(byId).filter((a): a is ActionSpec => !!a);
  const move = byId('move');
  const label = byId('label');
  const overflow = actions.filter((a) => !['archive', 'restore', 'delete', 'move', 'label'].includes(a.id));

  const trigger = (spec: ActionSpec) =>
    showText ? (
      <Button variant="ghost" icon={spec.icon}>
        {spec.label}
      </Button>
    ) : (
      <IconButton icon={spec.icon} label={spec.label} />
    );

  return (
    <div className={styles.bar} role="toolbar" aria-label="Liste eylemleri">
      <input
        ref={checkbox}
        type="checkbox"
        className={styles.checkbox}
        checked={all}
        onChange={onToggleAll}
        disabled={totalCount === 0}
        aria-label={all ? 'Tüm seçimi kaldır' : 'Tümünü seç'}
      />

      {has ? (
        <>
          <span className={styles.count} aria-live="polite">
            {selectedCount} seçili
          </span>
          <div className={styles.actions}>
            {primary.map((a) =>
              showText ? (
                <Button key={a.id} variant="ghost" icon={a.icon} onClick={() => onRun(a.id)} className={a.danger ? styles.danger : undefined}>
                  {a.label}
                </Button>
              ) : (
                <IconButton key={a.id} icon={a.icon} label={a.label} tone={a.danger ? 'danger' : 'default'} onClick={() => onRun(a.id)} />
              ),
            )}
            {move && (
              <Menu>
                <MenuTrigger asChild>{trigger(move)}</MenuTrigger>
                <MenuContent align="start">
                  <FolderMenuItems
                    folders={folders}
                    currentFolderId={currentFolderId}
                    variant="dropdown"
                    onPick={(id) => onRun('move', id)}
                  />
                </MenuContent>
              </Menu>
            )}
            {label && (
              <Menu>
                <MenuTrigger asChild>{trigger(label)}</MenuTrigger>
                <MenuContent align="start">
                  <LabelMenuItems labels={labels} variant="dropdown" onPick={(name) => onRun('label', name)} />
                </MenuContent>
              </Menu>
            )}
            {overflow.length > 0 && (
              <Menu>
                <MenuTrigger asChild>
                  <IconButton icon={Ellipsis} label="Diğer eylemler" />
                </MenuTrigger>
                <MenuContent align="end">
                  {overflow.map((a) => (
                    <MenuItem key={a.id} icon={actionSpec(a.id).icon} onSelect={() => onRun(a.id)}>
                      {a.label}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )}
          </div>
          <IconButton icon={X} label="Vazgeç" className={styles.dismiss} onClick={onClear} />
        </>
      ) : (
        <h1 className={styles.title}>{title}</h1>
      )}
    </div>
  );
}
