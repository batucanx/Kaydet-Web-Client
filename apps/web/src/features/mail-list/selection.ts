/** Multi-selection state for the mail list (mobile: `selectionProvider`). Pure and testable. */
export interface SelectionState {
  ids: ReadonlySet<string>;
  /** Anchor for Shift-range selection. */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set(), anchor: null };

export type SelectionAction =
  | { type: 'toggle'; id: string }
  | { type: 'range'; id: string; order: readonly string[] }
  | { type: 'selectAll'; order: readonly string[] }
  | { type: 'clear' }
  /** Drop ids that are no longer visible (moved, deleted, filtered out). */
  | { type: 'prune'; order: readonly string[] };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'toggle': {
      const ids = new Set(state.ids);
      if (ids.has(action.id)) ids.delete(action.id);
      else ids.add(action.id);
      return { ids, anchor: action.id };
    }
    case 'range': {
      const from = state.anchor === null ? -1 : action.order.indexOf(state.anchor);
      const to = action.order.indexOf(action.id);
      if (from < 0 || to < 0) return selectionReducer(state, { type: 'toggle', id: action.id });
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const ids = new Set(state.ids);
      for (const id of action.order.slice(lo, hi + 1)) ids.add(id);
      return { ids, anchor: state.anchor };
    }
    case 'selectAll':
      return { ids: new Set(action.order), anchor: state.anchor };
    case 'clear':
      return state.ids.size === 0 ? state : EMPTY_SELECTION;
    case 'prune': {
      if (state.ids.size === 0) return state;
      const visible = new Set(action.order);
      const ids = new Set([...state.ids].filter((id) => visible.has(id)));
      if (ids.size === state.ids.size) return state;
      return { ids, anchor: state.anchor && visible.has(state.anchor) ? state.anchor : null };
    }
  }
}
