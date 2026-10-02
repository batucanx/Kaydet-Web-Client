import type { FolderView, LabelView } from '../../data/types';
import { MenuItem, MenuSub } from '../../ui/Menu';
import { folderIcons } from '../../shell/folderIcons';
import { Tag } from 'lucide-react';
import type { ActionId, ActionSpec } from './actions';

type Variant = 'dropdown' | 'context';

/** Folder targets for "Taşı" (mobile `folderMenuItems`: every folder except the current one). */
export function FolderMenuItems({
  folders,
  currentFolderId,
  variant,
  onPick,
}: {
  folders: FolderView[];
  currentFolderId: string;
  variant: Variant;
  onPick: (folderId: string) => void;
}) {
  return (
    <>
      {folders
        .filter((f) => f.id !== currentFolderId)
        .map((f) => (
          <MenuItem key={f.id} variant={variant} icon={folderIcons[f.role]} onSelect={() => onPick(f.id)}>
            <span style={{ paddingLeft: `calc(${f.depth} * var(--space-lg))` }}>{f.name}</span>
          </MenuItem>
        ))}
    </>
  );
}

/** Label picker (mobile `labelMenuItems`; empty state string is mobile's). */
export function LabelMenuItems({
  labels,
  variant,
  onPick,
}: {
  labels: LabelView[];
  variant: Variant;
  onPick: (name: string) => void;
}) {
  if (labels.length === 0) {
    return (
      <MenuItem variant={variant} disabled>
        Henüz etiket yok
      </MenuItem>
    );
  }
  return (
    <>
      {labels.map((l) => (
        <MenuItem
          key={l.id}
          variant={variant}
          leading={<Tag size={16} style={{ color: `var(--avatar-${l.tone % 15}-fg)` }} />}
          onSelect={() => onPick(l.name)}
        >
          {l.name}
        </MenuItem>
      ))}
    </>
  );
}

/** Right-click menu content: all available actions, with Move/Label as submenus. */
export function RowContextMenuItems({
  actions,
  folders,
  labels,
  currentFolderId,
  onRun,
}: {
  actions: ActionSpec[];
  folders: FolderView[];
  labels: LabelView[];
  currentFolderId: string;
  onRun: (action: ActionId, arg?: string) => void;
}) {
  return (
    <>
      {actions.map((a) => {
        if (a.id === 'move') {
          return (
            <MenuSub key={a.id} variant="context" label={a.label} icon={a.icon}>
              <FolderMenuItems
                folders={folders}
                currentFolderId={currentFolderId}
                variant="context"
                onPick={(id) => onRun('move', id)}
              />
            </MenuSub>
          );
        }
        if (a.id === 'label') {
          return (
            <MenuSub key={a.id} variant="context" label={a.label} icon={a.icon}>
              <LabelMenuItems labels={labels} variant="context" onPick={(name) => onRun('label', name)} />
            </MenuSub>
          );
        }
        return (
          <MenuItem key={a.id} variant="context" icon={a.icon} danger={a.danger} onSelect={() => onRun(a.id)}>
            {a.label}
          </MenuItem>
        );
      })}
    </>
  );
}
