import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { iconSize } from '@kaydet/tokens';
import styles from './Menu.module.css';

/**
 * Shared, token-styled wrappers over Radix menus (focus management, typeahead, arrow keys and
 * ARIA come from Radix). The same item components serve both dropdown and context menus.
 */
export const Menu = DropdownPrimitive.Root;
export const MenuTrigger = DropdownPrimitive.Trigger;
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

type Variant = 'dropdown' | 'context';
const P = { dropdown: DropdownPrimitive, context: ContextMenuPrimitive } as const;

interface ContentProps extends Omit<ComponentProps<typeof DropdownPrimitive.Content>, 'className'> {
  variant?: Variant;
}

export function MenuContent({ variant = 'dropdown', sideOffset = 6, children, ...rest }: ContentProps) {
  const Prim = P[variant];
  return (
    <Prim.Portal>
      <Prim.Content className={styles.content} sideOffset={variant === 'dropdown' ? sideOffset : undefined} {...rest}>
        {children}
      </Prim.Content>
    </Prim.Portal>
  );
}

interface ItemProps {
  variant?: Variant;
  icon?: LucideIcon;
  /** Custom leading node (e.g. an avatar); takes precedence over `icon`. */
  leading?: ReactNode;
  children: ReactNode;
  meta?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export function MenuItem({
  variant = 'dropdown',
  icon: Icon,
  leading,
  children,
  meta,
  danger,
  disabled,
  onSelect,
}: ItemProps) {
  const Prim = P[variant];
  return (
    <Prim.Item
      className={`${styles.item} ${danger ? styles.danger : ''}`}
      disabled={disabled}
      onSelect={onSelect}
    >
      {leading ? (
        <span className={styles.icon} aria-hidden="true">
          {leading}
        </span>
      ) : (
        Icon && (
          <span className={styles.icon} aria-hidden="true">
            <Icon size={iconSize.sm} />
          </span>
        )
      )}
      <span className={styles.grow}>{children}</span>
      {meta !== undefined && <span className={styles.meta}>{meta}</span>}
    </Prim.Item>
  );
}

interface RadioProps {
  value: string;
  children: ReactNode;
  icon?: LucideIcon;
}

export function MenuRadioGroup(props: ComponentProps<typeof DropdownPrimitive.RadioGroup>) {
  return <DropdownPrimitive.RadioGroup {...props} />;
}

export function MenuRadioItem({ value, children, icon: Icon }: RadioProps) {
  return (
    <DropdownPrimitive.RadioItem value={value} className={styles.item}>
      {Icon && (
        <span className={styles.icon} aria-hidden="true">
          <Icon size={iconSize.sm} />
        </span>
      )}
      <span className={styles.grow}>{children}</span>
      <DropdownPrimitive.ItemIndicator className={styles.check}>
        <Check size={iconSize.sm} aria-hidden="true" />
      </DropdownPrimitive.ItemIndicator>
    </DropdownPrimitive.RadioItem>
  );
}

export function MenuSeparator({ variant = 'dropdown' }: { variant?: Variant }) {
  const Prim = P[variant];
  return <Prim.Separator className={styles.separator} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownPrimitive.Label className={styles.label}>{children}</DropdownPrimitive.Label>;
}

interface SubProps {
  variant?: Variant;
  label: string;
  icon?: LucideIcon;
  children: ReactNode;
}

export function MenuSub({ variant = 'dropdown', label, icon: Icon, children }: SubProps) {
  const Prim = P[variant];
  return (
    <Prim.Sub>
      <Prim.SubTrigger className={styles.subTrigger}>
        {Icon && (
          <span className={styles.icon} aria-hidden="true">
            <Icon size={iconSize.sm} />
          </span>
        )}
        <span className={styles.grow}>{label}</span>
        <ChevronRight size={iconSize.sm} aria-hidden="true" />
      </Prim.SubTrigger>
      <Prim.Portal>
        <Prim.SubContent className={styles.subContent} sideOffset={4}>
          {children}
        </Prim.SubContent>
      </Prim.Portal>
    </Prim.Sub>
  );
}
