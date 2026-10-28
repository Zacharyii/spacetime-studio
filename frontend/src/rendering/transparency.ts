import * as THREE from 'three';

export type TimeSide = 1 | -1;

export function stableTimeSide(previous: TimeSide, signedFacing: number, deadZone = 0.025): TimeSide {
  if (signedFacing > deadZone) return 1;
  if (signedFacing < -deadZone) return -1;
  return previous;
}

export function sliceRenderOrder(frameIndex: number, frameCount: number, side: TimeSide): number {
  return side === 1 ? frameIndex : frameCount - frameIndex;
}

export function sliceOpacityScale(normalFacing: number): number {
  return 0.08 + 0.92 * THREE.MathUtils.smoothstep(Math.abs(normalFacing), 0.025, 0.25);
}
