import type { CSSProperties } from 'react';
import { cx } from '../lib/cx';
import styles from './Skeleton.module.css';

export type SkeletonProps = {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  shape?: 'line' | 'pill' | 'box';
  soft?: boolean;
};

/** A placeholder block for content that is loading. Pair it with a LoadingLine that says what loads. */
export function Skeleton({ width = '100%', height = 10, shape = 'line', soft = false }: SkeletonProps) {
  return <div aria-hidden="true" className={cx(styles.skeleton, styles[shape], soft && styles.soft)} style={{ width, height }} />;
}
