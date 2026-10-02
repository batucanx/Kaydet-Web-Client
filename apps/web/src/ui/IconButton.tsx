import type { LucideIcon } from 'lucide-react';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { iconSize } from '@kaydet/tokens';
import styles from './IconButton.module.css';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Accessible name — also shown as the native tooltip. Required: icon-only buttons need a label. */
  label: string;
  /** `onAppBar` = sits on the top bar (brand blue in light theme). */
  tone?: 'default' | 'onAppBar' | 'danger';
  size?: keyof typeof iconSize;
  /** Toggle state (aria-pressed). */
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, tone = 'default', size = 'md', pressed, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${styles.button} ${styles[tone]} ${className ?? ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon size={iconSize[size]} aria-hidden="true" />
    </button>
  );
});
