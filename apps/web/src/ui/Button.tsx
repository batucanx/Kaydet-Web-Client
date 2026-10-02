import type { LucideIcon } from 'lucide-react';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { iconSize } from '@kaydet/tokens';
import styles from './Button.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: LucideIcon;
  children: ReactNode;
}

/** mobile: primary = accentFill/onAccentFill, secondary = 1px border, destructive = dangerFill. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon: Icon, children, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={`${styles.button} ${styles[variant]} ${className ?? ''}`} {...rest}>
      {Icon && <Icon size={iconSize.sm} aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
});
