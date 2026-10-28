import { describe, expect, it } from 'vitest';
import { sliceOpacityScale, sliceRenderOrder, stableTimeSide } from './transparency';

describe('time-slice transparency at edge-on views', () => {
  it('keeps the slice order stable while crossing the center dead zone', () => {
    expect(stableTimeSide(1, 0.01)).toBe(1);
    expect(stableTimeSide(1, -0.01)).toBe(1);
    expect(stableTimeSide(1, -0.04)).toBe(-1);
  });

  it('reverses render order when viewing the stack from the opposite side', () => {
    expect(sliceRenderOrder(0, 50, 1)).toBe(0);
    expect(sliceRenderOrder(0, 50, -1)).toBe(50);
    expect(sliceRenderOrder(49, 50, -1)).toBe(1);
  });

  it('fades smoothly toward edge-on and restores full opacity face-on', () => {
    expect(sliceOpacityScale(0)).toBeCloseTo(0.08);
    expect(sliceOpacityScale(0.1)).toBeGreaterThan(sliceOpacityScale(0.05));
    expect(sliceOpacityScale(1)).toBeCloseTo(1);
  });
});
