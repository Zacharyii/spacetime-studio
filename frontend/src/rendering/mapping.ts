export function timeCoordinate(frameIndex: number, frameCount: number, spacing: number): number {
  return (frameIndex - (frameCount - 1) / 2) * spacing;
}

export function estimateTextureMiB(width: number, height: number, count: number): number {
  return width * height * 4 * count / (1024 * 1024);
}
