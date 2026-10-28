import { describe, expect, it } from 'vitest';
import { cameraPoseAt } from './camera';

describe('deterministic camera timeline', () => {
  it('returns the same pose for the same time and preset', () => {
    const first = cameraPoseAt('side-reveal', 1.25, 5, 6);
    const second = cameraPoseAt('side-reveal', 1.25, 5, 6);
    expect(first.position.toArray()).toEqual(second.position.toArray());
    expect(first.target.toArray()).toEqual(second.target.toArray());
  });

  it('moves the fly-through camera along the time axis', () => {
    const start = cameraPoseAt('fly-through', 0, 5, 6).position.z;
    const end = cameraPoseAt('fly-through', 5, 5, 6).position.z;
    expect(end).toBeGreaterThan(start);
  });

  it('reveals the time axis by moving from front to side', () => {
    const start = cameraPoseAt('side-reveal', 0, 5, 6).position;
    const end = cameraPoseAt('side-reveal', 5, 5, 6).position;
    expect(Math.abs(end.y)).toBeGreaterThan(Math.abs(start.y));
    expect(Math.abs(end.z)).toBeLessThan(Math.abs(start.z));
  });

  it('keeps the time axis vertical as the side reveal reaches its side view', () => {
    const start = cameraPoseAt('side-reveal', 0, 5, 6);
    const end = cameraPoseAt('side-reveal', 5, 5, 6);
    expect(start.up.y).toBeCloseTo(1);
    expect(Math.abs(end.up.z)).toBeCloseTo(1);
  });
});
