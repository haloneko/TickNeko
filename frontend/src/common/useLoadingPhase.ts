/**
 * 加载相位：把「loading 布尔」翻译成骨架屏真正需要的三个时间点。
 *
 * 直接拿 loading 决定画不画骨架有两个老问题：
 * 1) 快请求（< 250ms）会先闪一帧骨架再出内容 —— 比一直空着更晃眼；
 * 2) 慢请求（十几秒）时骨架永远在闪，看的人分不清「在加载」还是「卡死了」。
 *
 * 所以把一次加载切成三段，页面按段决定渲染：
 * - 250ms 内：`active` 为真、`showSkeleton` 为假 —— 内容区保持原样（旧内容留着），不闪；
 * - 250ms 后：`showSkeleton` 为真 —— 画骨架 + 扫光；
 * - 9s 后：`slow` 为真 —— 骨架停扫光（`.skeleton-calm`），另给「加载较慢 + 重试」。
 * 三者严格嵌套（slow ⊂ showSkeleton ⊂ active），加载一结束同时回落。
 */
import { useEffect, useState } from 'react'

/** 小于它就当加载「瞬间完成」：不画骨架，省得闪一下 */
export const SKELETON_DELAY_MS = 250
/** 超过它就从「在加载」改口叫「加载较慢」，并把重试交回给用户 */
export const SLOW_LOADING_MS = 9000

export interface LoadingPhase {
  /** 请求在飞（含最初 250ms）：内容区该保持「加载中」的语义，别显示空态或旧错误 */
  active: boolean
  /** 够久了，该画骨架（> 250ms） */
  showSkeleton: boolean
  /** 太久了，骨架该停扫光并给重试（> 9s） */
  slow: boolean
}

const IDLE: LoadingPhase = { active: false, showSkeleton: false, slow: false }
const PENDING: LoadingPhase = { active: true, showSkeleton: false, slow: false }

/** 这一刻该显示哪一态 —— 两套区域外壳（LoadingRegion / TableFrame）共用，免得各拍一份优先级 */
export type LoadingView = 'error' | 'empty' | 'skeleton' | 'content'

/**
 * 相位 + 数据状态 → 显示态。优先级：
 * 1) 请求还在飞（`active`，含最初 250ms）时**只看**相位：错误 / 空态都先让位 ——
 *    重试期间 error 还留着旧值，那时该显示的是加载态，不是旧的错误框；
 *    250ms 内则既不画骨架也不判空态，直接把上一次的内容留在原地（快请求不闪）；
 * 2) 落定后：错误 > 空态 > 内容。
 */
export function loadingView(
  phase: LoadingPhase,
  { hasError, isEmpty }: { hasError: boolean; isEmpty: boolean },
): LoadingView {
  if (phase.active) return phase.showSkeleton ? 'skeleton' : 'content'
  if (hasError) return 'error'
  if (isEmpty) return 'empty'
  return 'content'
}

export function useLoadingPhase(
  loading: boolean,
  { delay = SKELETON_DELAY_MS, slow = SLOW_LOADING_MS }: { delay?: number; slow?: number } = {},
): LoadingPhase {
  // 初值跟着 loading 走：首次渲染（loading 已为 true）就得是 pending，
  // 否则会先画一帧空态 —— 那正是这套相位要消灭的闪烁。
  const [phase, setPhase] = useState<LoadingPhase>(() => (loading ? PENDING : IDLE))

  useEffect(() => {
    if (!loading) {
      setPhase(IDLE) // 常量引用，未加载时重复设值不会引起重渲染
      return
    }
    setPhase(PENDING)
    // 两个阈值只往前推、不往回退：到点整块替换比按位合并更省心
    const showTimer = window.setTimeout(
      () => setPhase({ active: true, showSkeleton: true, slow: false }),
      delay,
    )
    const slowTimer = window.setTimeout(
      () => setPhase({ active: true, showSkeleton: true, slow: true }),
      slow,
    )
    return () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(slowTimer)
    }
  }, [loading, delay, slow])

  return phase
}
