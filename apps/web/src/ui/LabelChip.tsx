import { avatarTones } from '@kaydet/tokens';
import styles from './LabelChip.module.css';

/** Label chip. mobile: tone from the same 15-tone palette as avatars (`LabelRow.toneIndex`). */
export function LabelChip({ name, tone }: { name: string; tone: number }) {
  const index = ((tone % avatarTones.light.length) + avatarTones.light.length) % avatarTones.light.length;
  return (
    <span className={styles.chip} style={{ background: `var(--avatar-${index}-bg)`, color: `var(--avatar-${index}-fg)` }}>
      {name}
    </span>
  );
}
