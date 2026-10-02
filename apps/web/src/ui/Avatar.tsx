import { Check } from 'lucide-react';
import { avatarTones } from '@kaydet/tokens';
import { avatarToneIndex } from '../lib/avatar';
import { avatarInitial } from '../lib/turkish';
import styles from './Avatar.module.css';

interface AvatarProps {
  name: string | null | undefined;
  email: string | null | undefined;
  /** Diameter in px (mobile default 32, `Dimens.avatarSize`). */
  size?: number;
  /** Selected state: accentFill + check mark (mobile `KaydetAvatar.isSelected`). */
  selected?: boolean;
}

/** Sender avatar: tone from an FNV-1a hash of the address, so a person keeps their color. */
export function Avatar({ name, email, size = 32, selected = false }: AvatarProps) {
  const tone = avatarToneIndex(email, name, avatarTones.light.length);
  return (
    <span
      className={`${styles.avatar} ${selected ? styles.selected : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        ...(selected ? {} : { background: `var(--avatar-${tone}-bg)`, color: `var(--avatar-${tone}-fg)` }),
      }}
      aria-hidden="true"
    >
      {selected ? <Check size={size * 0.45} strokeWidth={2.5} /> : avatarInitial(name, email)}
    </span>
  );
}
