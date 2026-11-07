/** 二级菜单的视口定位；外框尺寸来自实际文字测量，不按条目数估行高。 */
export interface MenuRect { left: number; right: number; top: number; bottom: number }
export interface SubmenuBounds { left: number; top: number; width: number; height: number; side: 'left' | 'right' }

export function placeSubmenu(anchor: MenuRect, main: MenuRect,
  content: { width: number; height: number }, viewport: { width: number; height: number }): SubmenuBounds {
  const gap = 8
  const width = Math.min(Math.max(176, content.width), Math.max(1, viewport.width - gap * 2))
  const height = Math.min(content.height, 380, Math.max(1, viewport.height - gap * 2))
  const rightSpace = viewport.width - main.right - gap - 4
  const leftSpace = main.left - gap - 4
  const side = rightSpace >= width || rightSpace >= leftSpace ? 'right' : 'left'
  const clamp = (value: number, size: number, maximum: number) =>
    Math.max(Math.min(gap, Math.max(0, maximum - size)), Math.min(value, maximum - size - gap))
  const preferredTop = anchor.top - 4
  return {
    left: clamp(side === 'right' ? main.right + 4 : main.left - width - 4, width, viewport.width),
    top: clamp(preferredTop + height > viewport.height - gap ? anchor.bottom + 4 - height : preferredTop, height, viewport.height),
    width, height, side,
  }
}
