/** 主菜单退场时保留 DOM；重新打开或卸载时取消旧退场，避免误关新菜单。 */
export const CONTEXT_MENU_EXIT_MS = 140

export function deferMenuRemoval(remove: () => void, reducedMotion: boolean): () => void {
  if (reducedMotion) {
    remove()
    return () => {}
  }
  // 留两帧给动画开始与收尾；这段时间菜单已 inert，不截获点击或键盘操作。
  const timer = setTimeout(remove, CONTEXT_MENU_EXIT_MS + 32)
  return () => clearTimeout(timer)
}
