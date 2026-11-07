/**
 * 右键菜单的**唯一出口**：把菜单状态（哪一份、在哪儿、命中了谁）与编辑器采集到的状态拼成一份
 * :interface:`MenuContext`，再交给渲染器画 :file:`menu.tsx` 里那张配置表。
 *
 * 「采集状态」只在这里发生一次 —— 新增按钮要用到别的状态时，除了往 ``MenuContext`` 加字段，
 * 就只在这个文件里多接一个 prop，别处不用动。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { ContextMenuList } from './ContextMenuList'
import { deferMenuRemoval } from './menuMotion'
import { MENUS, type MenuActions, type MenuContext } from './menu'
import type { NodeTypeSpec } from './catalog'
import type { MenuState } from './useContextMenu'

export interface ContextMenuHostProps {
  state: MenuState | null
  menuRef: React.RefObject<HTMLDivElement>
  /** 节点类型目录（「添加节点」的二级菜单用；还没拉回来就传 null） */
  catalog: NodeTypeSpec[] | null
  /** 剪贴板里有没有能贴的节点（决定「粘贴」显不显示） */
  canPaste: boolean
  /** 菜单动作的实现（编辑器给，见 WorkflowEditor） */
  actions: MenuActions
  /** 点完任一项之后收菜单 */
  onClose: () => void
}

export function ContextMenuHost({
  state,
  menuRef,
  catalog,
  canPaste,
  actions,
  onClose,
}: ContextMenuHostProps) {
  const [retained, setRetained] = useState<{ state: MenuState; key: number } | null>(null)
  const revision = useRef(0)
  useLayoutEffect(() => {
    if (state) {
      setRetained({ state, key: ++revision.current })
      return
    }
    return deferMenuRemoval(
      () => setRetained(null),
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    )
  }, [state])

  const shown = state ?? retained?.state
  if (!shown) return null
  const ctx: MenuContext = {
    kind: shown.kind,
    ids: shown.kind === 'node' ? shown.ids : [],
    point: shown.point,
    canPaste,
    catalog,
  }
  return (
    <ContextMenuList
      key={retained?.key ?? 0}
      x={shown.x}
      y={shown.y}
      leaving={state === null}
      menuRef={menuRef}
      entries={MENUS[ctx.kind]}
      ctx={ctx}
      actions={actions}
      onDone={onClose}
    />
  )
}
