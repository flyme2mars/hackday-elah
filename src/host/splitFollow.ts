export interface SplitPair {
  readonly leftId: string
  readonly rightId: string
}

const SPLIT_FOLLOW_OPS = new Set(['trim', 'set_transform', 'set_motion', 'remove'])

/** Copies name engine ids so remember() cannot point the parent alias at the right half. */
export function opsForSplitParents<T extends { op: string; clip_id?: string }>(
  op: T,
  pairs: ReadonlyMap<string, SplitPair>,
): readonly T[] {
  if (!SPLIT_FOLLOW_OPS.has(op.op) || !op.clip_id) return [op]
  const pair = pairs.get(op.clip_id)
  if (!pair) return [op]
  return [
    { ...op, clip_id: pair.leftId },
    { ...op, clip_id: pair.rightId },
  ]
}
