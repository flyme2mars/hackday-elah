import { transformFromContainRect, type Transform } from '@elah/editor'

/**
 * Overnight stub tagged phone clips looked upside-down vs thumbnails, so we tried
 * scaleY:-1. On the real HackDay vault that doubles wrong and Preview shows 180°.
 * Keep helpers for experiments, but never auto-apply.
 */
export function needsUprightFlip(_vaultId: string, _width?: number, _height?: number): boolean {
  return false
}

/** Contain-fit, centered. scaleY:-1 kept for manual experiments only. */
export function uprightVideoTransform(
  stageWidth: number,
  stageHeight: number,
  contentWidth: number,
  contentHeight: number,
): Transform {
  const fit = transformFromContainRect(contentWidth, contentHeight, stageWidth, stageHeight)
  return {
    x: fit.x,
    y: fit.y,
    scale: fit.scale,
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
  }
}
