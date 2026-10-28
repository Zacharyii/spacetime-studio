import { describe, expect, it } from 'vitest';
import { estimateTextureMiB, timeCoordinate } from './mapping';

describe('space-time mapping', () => {
  it('places different times at different Z values and scales with spacing', () => {
    expect(timeCoordinate(1, 5, 0.2)).toBeLessThan(timeCoordinate(4, 5, 0.2));
    expect(timeCoordinate(4, 5, 0.4)).toBe(timeCoordinate(4, 5, 0.2) * 2);
  });
  it('estimates RGBA texture memory', () => {
    expect(estimateTextureMiB(512, 512, 4)).toBe(4);
  });
});
