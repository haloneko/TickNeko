/**
 * 右键菜单的**渲染器**：把 :file:`menu.tsx` 里那张配置表画出来，外加定位与二级菜单的翻转。
 *
 * 它不认识任何具体按钮，只会四件事：按状态过滤（``visible``）、算行高与位置、画按钮、收菜单。
 * 连行高都不写死在「标题 27 + 每行 32」那种口径上 —— 位置是按**实际会画出来的那几行**累加出来的，
 * 所以往配置表里加 / 删按钮，菜单位置与二级菜单的展开方向不用跟着改。
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { IconChevronRight } from '../../../common/icons'
import { categoryLabel, groupByCategory } from './catalog'
import { ContextSubmenu, type ActiveSubmenu } from './ContextSubmenu'
import type { MenuActions, MenuContext, MenuEntry } from './menu'
import { CONTEXT_MENU_EXIT_MS } from './menuMotion'
import styles from '../WorkflowEditor.module.css'

//: 各类行的高度（px）：只用来估菜单位置，不参与渲染
const ROW_H = 32
const TITLE_H = 27
const SEP_H = 9
//: 菜单内边距（与 CSS 的 .ctxMenu padding 一致）
const PAD = 4
//: 一级菜单最小宽度；二级菜单由 ContextSubmenu 实测
const MENU_W = 184
//: 与视口边缘留的空隙
const GAP = 8

export interface ContextMenuListProps {
  /** 视口坐标（``position: fixed``） */
  x: number
  y: number
  leaving?: boolean
  menuRef: React.RefObject<HTMLDivElement>
  entries: MenuEntry[]
  ctx: MenuContext
  actions: MenuActions
  /** 点完任一项（含二级项）之后收菜单 */
  onDone: () => void
}

interface Row {
  entry: MenuEntry
  /** 这一行距菜单顶部的偏移（px） */
  offset: number
  h: number
}

/** 这一行有多高：二级菜单那一项要把分组标题与分类行一起算进去。 */
function heightOf(entry: MenuEntry, ctx: MenuContext): number {
  if (entry.kind === 'separator') return SEP_H
  if (entry.kind === 'catalog') {
    return TITLE_H + groupByCategory(ctx.catalog ?? []).length * ROW_H
  }
  return ROW_H
}

/**
 * 先按状态过滤、再去掉没有意义的分隔线（开头 / 结尾 / 连着两根），最后累加出每一行的偏移。
 * 配置里因此不用写「这根线在有粘贴时才显示」这类跟随条件。
 */
function layout(entries: MenuEntry[], ctx: MenuContext): Row[] {
  const alive = entries.filter((entry) => entry.visible?.(ctx) ?? true)
  const kept = alive.filter(
    (entry, i) =>
      entry.kind !== 'separator' ||
      (i > 0 && i < alive.length - 1 && alive[i - 1].kind !== 'separator'),
  )
  const rows: Row[] = []
  let offset = PAD
  for (const entry of kept) {
    const h = heightOf(entry, ctx)
    rows.push({ entry, offset, h })
    offset += h
  }
  return rows
}

export function ContextMenuList({
  x,
  y,
  leaving = false,
  menuRef,
  entries,
  ctx,
  actions,
  onDone,
}: ContextMenuListProps) {
  /** 当前分类及其定位锚点；null 表示全部收起。 */
  const [submenu, setSubmenu] = useState<ActiveSubmenu | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  useEffect(() => cancelClose, [])

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return
    element.toggleAttribute('inert', leaving)
  }, [leaving, menuRef])

  const rows = layout(entries, ctx)
  const menuH = rows.reduce((sum, row) => sum + row.h, PAD * 2)
  const left = Math.max(GAP, Math.min(x, window.innerWidth - MENU_W - GAP))
  const top = Math.max(GAP, Math.min(y, Math.max(GAP, window.innerHeight - menuH - GAP)))

  /** 一个可点的普通项：跑动作，然后收菜单 */
  const run = (fn: () => void) => {
    fn()
    onDone()
  }

  const renderRow = ({ entry }: Row) => {
    if (entry.kind === 'separator') return <div key={entry.id} className={styles.ctxMenuSep} />
    if (entry.kind === 'action') {
      return (
        <button
          key={entry.id}
          className={
            entry.danger
              ? `${styles.ctxMenuItem} ${styles.ctxMenuItemDanger}`
              : styles.ctxMenuItem
          }
          onClick={() => run(() => entry.run(ctx, actions))}
          onMouseEnter={() => { cancelClose(); setSubmenu(null) }}
        >
          {entry.icon}
          {entry.label(ctx)}
        </button>
      )
    }

    // catalog：一行分组标题 + 每个分类一行，悬停展开该分类下的节点类型
    const groups = groupByCategory(ctx.catalog ?? [])
    return (
      <Fragment key={entry.id}>
        <div className={styles.ctxMenuTitle}>{entry.title}</div>
        {groups.map(([category, specs]) => {
          const rowId = `${entry.id}:${category}`
          const open = submenu?.id === rowId
          const show = (anchor: HTMLElement) => {
            cancelClose()
            const main = menuRef.current
            if (main) setSubmenu(last => last?.id === rowId ? last : { id: rowId, specs, anchor, main })
          }
          return (
            <div
              key={rowId}
              className={styles.ctxSubWrap}
              onMouseEnter={event => show(event.currentTarget)}
            >
              <button
                className={styles.ctxMenuItem}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={event => show(event.currentTarget)}
              >
                <span className={`${styles.ctxDot} ${styles.ctxDotGroup}`} />
                {categoryLabel(category)}
                <span className={styles.ctxMenuCount}>{specs.length}</span>
                <span className={styles.ctxMenuArrow}>
                  <IconChevronRight size={13} />
                </span>
              </button>

            </div>
          )
        })}
      </Fragment>
    )
  }

  return (
    <div
      ref={menuRef}
      className={styles.ctxMenu}
      data-menu-phase={leaving ? 'leaving' : 'open'}
      aria-hidden={leaving || undefined}
      style={{
        left,
        top,
        minWidth: MENU_W,
        '--ctx-origin-x': `${Math.max(0, Math.min(x - left, MENU_W))}px`,
        '--ctx-origin-y': `${Math.max(0, Math.min(y - top, menuH))}px`,
        '--ctx-text-offset': y - top > menuH / 2 ? '-6px' : '6px',
        '--ctx-exit-duration': `${CONTEXT_MENU_EXIT_MS}ms`,
      } as CSSProperties}
      onClickCapture={(event) => {
        if (leaving) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={cancelClose}
      onMouseLeave={() => {
        cancelClose()
        closeTimer.current = setTimeout(() => setSubmenu(null), 100)
      }}
    >
      {rows.map(renderRow)}
      <ContextSubmenu active={submenu} leaving={leaving}
        onPick={type => run(() => actions.add(type, ctx.point))} />
    </div>
  )
}
