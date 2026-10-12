/**
 * Keeps a fixed-position popover (NodeKindPalette, NodeContextMenu) fully on-screen. Without
 * this, right-clicking (or dropping a drag) near the right/bottom edge of the window renders a
 * menu whose lower options are literally unreachable — found live via the drag-to-empty-canvas
 * e2e test, not a hypothetical.
 */
export function clampToViewport(
  position: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}
