/**
 * 加载区域外壳（整块替换版）：把「一次异步取数」的四态收口到一处 ——
 * 骨架 / 空态 / 错误 / 内容，外加页脚三态与读屏播报。
 *
 * 页面只需要说清两件事：**数据长什么样**（`skeleton` / `children` / `empty` / `error`）
 * 和**怎么重来**（`onRetry` / `loading`）。相位、250ms 延迟、9s 慢加载、aria 播报
 * 全在这里，页面不再自己写 `loading ? ... : error ? ...` 这套分支。
 *
 * 形态无关：骨架与内容都由调用方整块给（`<ul>` / 卡片网格 / 整页版式都行），
 * 所以它不认 DOM 结构、也不套多余的元素 —— 布局仍是各页自己的。
 *
 * 表格不能用它：表格要的是「只换 tbody 里的行、thead 与列宽跨加载态保留」，
 * 那是行级的替换，交给 `TableFrame`。
 */
import type { ReactNode } from 'react'
import ErrorBox, { type ErrorState } from './ErrorBox'
import { LoadingFooter, SkeletonLiveRegion, type LoadingFooterSlots } from './Skeleton'
import { loadingView, useLoadingPhase } from './useLoadingPhase'

/** 错误块要求一个 onRetry；走到错误态时 error 一定有值，缺 onRetry 就兜个空函数 */
const noop = () => {}

interface LoadingRegionProps {
  /** 正在取数（含最初 250ms：此时不换内容，只把 aria 播报挂上） */
  loading: boolean
  /** 归一后的错误（形状同 ErrorBox，`usePagedQuery` 的 error 直接喂进来） */
  error?: ErrorState | null
  /** 本轮数据是否为空；只在相位落定后才会被看到 */
  isEmpty?: boolean
  /** 重试：错误块的按钮与慢加载提示共用它；不给就不出慢加载提示 */
  onRetry?: () => void
  /** 加载态占位：形态自带（整块 `<ul>` / 卡片网格 / 整页版式） */
  skeleton: ReactNode
  /** 空态内容；默认不显示（有些区域「空」也有内容，如带「新建」入口的卡片网格） */
  empty?: ReactNode
  /** 错误态内容；不给就用通用 ErrorBox（此时必须给 onRetry） */
  errorBox?: ReactNode
  /** 页脚两态（真分页条 / 骨架块）；没有页脚的页面整个不给 */
  footer?: LoadingFooterSlots
  /** 读屏播报文案，如「正在加载运行日志…」 */
  liveLabel?: string
  /** 拿到数据后真正要渲染的内容 */
  children: ReactNode
}

export default function LoadingRegion({
  loading,
  error,
  isEmpty = false,
  onRetry,
  skeleton,
  empty,
  errorBox,
  footer,
  liveLabel,
  children,
}: LoadingRegionProps) {
  const phase = useLoadingPhase(loading)
  const view = loadingView(phase, { hasError: !!error, isEmpty })

  return (
    <>
      <SkeletonLiveRegion active={phase.active} label={liveLabel} />
      {view === 'error' ? (
        errorBox ?? (error && <ErrorBox error={error} onRetry={onRetry ?? noop} />)
      ) : view === 'empty' ? (
        empty
      ) : view === 'skeleton' ? (
        // 慢加载：整块骨架也停扫光。骨架是调用方整块给的（`<ul>` / 卡片网格 / 整页版式），
        // 外壳没法直接给它挂类，所以套一层只负责这个类的 div —— 它在骨架分支里始终存在、
        // 只切换类名（不重建骨架），而这几种形态都是块级容器，多一层不影响布局。
        // 表格那边不需要这层：TableFrame 把 `calm` 直接传给了骨架行。
        <div className={phase.slow ? 'skeleton-calm' : undefined}>{skeleton}</div>
      ) : (
        children
      )}
      {/* 错误 / 空态整块占住时不给页脚：那两态没有可翻的页 */}
      {(view === 'skeleton' || view === 'content') && (
        <LoadingFooter phase={phase} footer={footer} onRetry={onRetry} />
      )}
    </>
  )
}
