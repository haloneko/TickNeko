/**
 * 全屏编辑视图（IDE 风格）：顶栏（标题 + 视图 tab 槽位 + 操作按钮）、
 * 可滚动内容区、底部状态栏。适合「点编辑进全屏」的大面积编辑场景。
 *
 * 与 Modal 的区别：占满整屏而非居中浮层；顶栏中间留了 tabs 槽位放
 * 「表单 / JSON」这类视图切换；底部 status 展示错误、草稿等状态。
 * Esc 关闭；传 onSave 时按 Ctrl/Cmd+S 直接保存（并拦下浏览器的「保存网页」）；
 * busy 时锁关，关闭行为与 Modal 一致。
 *
 */
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons'
import styles from './FullscreenDialog.module.css'

export interface FullscreenDialogProps {
  title: ReactNode
  /** 顶栏中间的视图切换区（如「表单 / JSON」tab），不需要则不传 */
  tabs?: ReactNode
  /** 顶栏右侧操作区（保存、重新读取等） */
  actions?: ReactNode
  children: ReactNode
  /** 底部状态栏内容（错误、草稿标记、类型信息等），不需要则不渲染状态栏 */
  status?: ReactNode

  busy?: boolean
  onSave?: () => void
  onClose: () => void
}

export function FullscreenDialog({
  title,
  tabs,
  actions,
  children,
  status,
  busy = false,
  onSave,
  onClose,
}: FullscreenDialogProps) {
  // Esc 关闭（处理中不关），与 Modal / ConfirmDialog 行为一致；Ctrl/Cmd+S 交给 onSave，
  // 必须先 preventDefault，否则浏览器会抢先弹出「保存网页」对话框。
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!busy) onClose()
        return
      }
      if (!onSave) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!busy && !event.repeat) onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose, onSave])

  // 全屏层占满视口，但固定定位盖不住窗口滚动条：背景页仍能滚，滚动条会一直留在
  // 最右侧，与内容区自己的滚动条并排，看起来像「两个滑动条」。打开期间锁住文档滚动
  // （关闭时还原），只保留内容区那一条。
  useEffect(() => {
    const { documentElement } = document
    const previous = documentElement.style.overflow
    documentElement.style.overflow = 'hidden'
    return () => {
      documentElement.style.overflow = previous
    }
  }, [])

  return createPortal(
    <div className={styles.shell} role="dialog" aria-modal="true">
      <div className={styles.bar}>
        <h3 className={styles.title}>{title}</h3>
        <div className={styles.tabs}>{tabs}</div>
        <div className={styles.actions}>{actions}</div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭"
        >
          <IconClose size={18} />
        </button>
      </div>
      <div className={styles.body}>{children}</div>
      {status && <div className={styles.status}>{status}</div>}
    </div>,
    document.body,
  )
}

export default FullscreenDialog
