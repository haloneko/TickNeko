/**
 * 加载区域外壳（表格版）：表格壳 + 行级替换。
 *
 * 和 `LoadingRegion` 的差别只在 DOM 策略：表格的列宽与表头在加载态 / 数据态应该是**同一棵**
 * 树 —— 只把 `<tbody>` 里的行换成骨架行，`<table>` 与 `<thead>` 跨加载态保留。于是翻页 /
 * 点查询 / 改每页条数时列宽不重算、表头不重建（整表替换会一次切换 remount 两遍）。
 *
 * 四态与页脚的口径和 `LoadingRegion` 完全一致（共用 `loadingView` / `LoadingFooter`），
 * 页面只给：列配置、真实行、页脚，以及错误 / 空态长什么样。
 */
import type { ReactNode } from 'react'
import ErrorBox, { type ErrorState } from './ErrorBox'
import {
  LoadingFooter,
  SkeletonLiveRegion,
  TableHeader,
  TableSkeletonRows,
  type LoadingFooterSlots,
  type TableColumn,
} from './Skeleton'
import { loadingView, useLoadingPhase } from './useLoadingPhase'

interface TableFrameProps {
  /** 列配置：真实行与骨架行共用同一份（列序 / 列宽 / 单元格 class / 占位内容） */
  columns: readonly TableColumn[]
  /** 表格自身的 class：列宽之外的行高 / 内边距 / 边框都在它里面 */
  tableClassName: string
  /** 横向滚动容器（窄屏靠它滚，别让外层卡片把右侧的「操作」裁掉）；不传就不套 */
  wrapClassName?: string
  /** 正在取数 */
  loading: boolean
  /** 归一后的错误；非空且相位落定后整块换成错误态 */
  error?: ErrorState | null
  /** 本轮数据是否为空 */
  isEmpty?: boolean
  /** 重试：错误块按钮与慢加载提示共用 */
  onRetry: () => void
  /** 空态内容（各页文案不同） */
  empty?: ReactNode
  /** 错误态内容；不给就用通用 ErrorBox */
  errorBox?: ReactNode
  /** 页脚两态（真分页条 / 骨架块）；没有分页的表格整个不给 */
  footer?: LoadingFooterSlots
  /** 读屏播报文案，如「正在加载表格数据…」 */
  liveLabel?: string
  /** 真实行（`<tr>` 列表） */
  children: ReactNode
}

export default function TableFrame({
  columns,
  tableClassName,
  wrapClassName,
  loading,
  error,
  isEmpty = false,
  onRetry,
  empty,
  errorBox,
  footer,
  liveLabel,
  children,
}: TableFrameProps) {
  const phase = useLoadingPhase(loading)
  const view = loadingView(phase, { hasError: !!error, isEmpty })

  return (
    <>
      {/* 播报节点常驻在这里（视觉上 sr-only）：跨加载态都不卸载，aria-live 才播得稳 */}
      <SkeletonLiveRegion active={phase.active} label={liveLabel} />
      {view === 'error' ? (
        errorBox ?? (error ? <ErrorBox error={error} onRetry={onRetry} /> : null)
      ) : view === 'empty' ? (
        empty
      ) : (
        <div className={wrapClassName}>
          {/* aria-busy 标在「内容会变的那张表」上：加载中它仍是同一张表、同一个表头 */}
          <table className={tableClassName} aria-busy={phase.active}>
            <TableHeader columns={columns} />
            <tbody>
              {view === 'skeleton' ? (
                <TableSkeletonRows columns={columns} calm={phase.slow} />
              ) : (
                children
              )}
            </tbody>
          </table>
        </div>
      )}
      {/* 错误 / 空态整块占住时不给页脚：那两态没有可翻的页 */}
      {(view === 'skeleton' || view === 'content') && (
        <LoadingFooter phase={phase} footer={footer} onRetry={onRetry} />
      )}
    </>
  )
}
