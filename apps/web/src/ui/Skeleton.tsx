import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  circle?: boolean;
  className?: string;
}

/** Placeholder block (mobile: `ShimmerBar`). Pulses opacity only — no gradients; static under reduced motion. */
export function Skeleton({ width = '100%', height = 12, circle = false, className }: SkeletonProps) {
  return (
    <span
      className={`${styles.skeleton} ${circle ? styles.circle : ''} ${className ?? ''}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
