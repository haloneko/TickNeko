/**
 * 骨架屏占位：列表 / 卡片加载时替代 spinner，降低等待感知。
 * 纯展示组件，整体 aria-hidden，避免读屏器把占位读成内容。
 *
 * 分两层：
 * 1) 原子件（Skeleton / SkeletonText / SkeletonBox / SkeletonChip / SkeletonButton）
 *    只提供统一的视觉语言（颜色、圆角、不收缩）与合理默认尺寸，
 *    不声明业务版式。调用方应当复用真实内容的 class（如 styles.row / styles.rowMain），
 *    把原子塞进去 —— 这样间距、内边距、边框跟随真实 CSS，加载完切换不会跳高，
 *    也不存在第二份尺寸副本可以腐化。
 * 2) 复合件（CardGridSkeleton / 表格那一组）
 *    是「通用近似版式」，只适合形状确实重复的场景；形状差异大的列表请用原子自己拼。
 *    表格那组额外把「列」这件事摆到台面上：真实表与骨架表共用同一份列配置，
 *    连列宽都由同一处 <colgroup> 声明（见 TableColumn / TableColgroup）。
 */
import type { CSSProperties, ReactNode } from 'react'
import type { LoadingPhase } from './useLoadingPhase'

type SkeletonProps = {
  /** 宽度：数字按 px，字符串原样（如 '60%'） */
  width?: number | string
  /** 高度：数字按 px，默认 12 */
  height?: number | string
  /** 圆角：数字按 px，字符串原样（如 '50%'），默认继承 .skeleton 令牌 */
  radius?: number | string
  className?: string
  style?: CSSProperties
}

/** 单个骨架块，尺寸可完全自定义，用于拼装任意版式 */
export function Skeleton({
  width,
  height = 12,
  radius,
  className = '',
  style,
}: SkeletonProps) {
  return (
    <span
      className={`skeleton ${className}`.trim()}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  )
}

/**
 * 卡片网格型骨架：和卡片网格同列数，逐项复刻实际卡片的版式
 * （标签 + 状态点 / 三行「字段名 + 值」/ 底部开关 + 操作按钮），
 * 内边距、间距、行高、按钮高度都按真实卡片对齐，加载完切换不跳高。
 */
export function CardGridSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-cards" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="skeleton-card" key={i}>
          <div className="skeleton-card-top">
            <Skeleton width={96} height={24} radius={999} />
            <div className="skeleton-card-status">
              <span className="skeleton skeleton-card-dot" />
              <Skeleton width={36} height={12} />
            </div>
          </div>
          <div className="skeleton-card-fields">
            {[0, 1, 2].map((j) => (
              <div className="skeleton-card-field" key={j}>
                <span className="skeleton skeleton-card-dt" />
                <Skeleton width={`${26 + ((i * 17 + j * 29) % 38)}%`} height={21} />
              </div>
            ))}
          </div>
          <div className="skeleton-card-foot">
            <span className="skeleton skeleton-card-switch" />
            <div className="skeleton-card-btns">
              <span className="skeleton skeleton-card-btn" />
              <span className="skeleton skeleton-card-btn" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ 表格（复合件） */

/* 表格骨架的「层高」：同一行里同类元素共用一个高度。
   两档都是全局量（正文字号 × 全局 line-height、公共 .chip），所以放 common 而不是各页一份；
   真实值相差不到 1px 的不再单独复制 —— 两个实心块并排时，那点差异只会显示成一道台阶。 */
export const TEXT_H = 21 // 文字条 = 正文 13px × 全局 line-height 1.6 ≈ 20.8
export const BADGE_H = 26 // 填充徽标 / 胶囊 = .chip(25.2)、.scopeBadge(25.6) 取上整

/**
 * 表格骨架的列配置：真实表与骨架表共用同一份 —— 列序、列宽权重、单元格 class、占位内容
 * 都只有一处，不可能出现「加了列忘了改骨架」，也不会出现骨架与真实行换列宽。
 * 页面各自的 COLUMNS 只要满足这个形状（额外字段随意，如 adminOnly）就能直接喂进来。
 */
export type TableColumn = {
  /** 表头文案；同时充当列的唯一标识（React key） */
  label: string
  /** 列宽权重：各列之和为分母，归一成百分比写进 <col>；配合 table-layout: fixed 定死列宽 */
  width: number
  /** 该列表头 / 单元格右对齐 */
  alignRight?: boolean
  /** 真实行里这一列 td 的 class（骨架行沿用同一个；没有 class 的列就不写） */
  td?: string
  /** 这一列在骨架行里的占位内容；`row` 是行号，用来让同列的占位宽度错落 */
  skeleton?: (row: number) => ReactNode
}

/**
 * 骨架行数：只铺「一屏多」。
 * 骨架不承担「填满整屏」的职责 —— 长等待由 250ms 之后的骨架与 9s 之后的
 * 「加载较慢 + 重试」接管；铺得太多反而会把加载态糊成一片。故贴着下限取。
 */
export const SKELETON_ROWS = 6

/**
 * 列宽声明：只声明宽度，不声明内容。
 * `table-layout: fixed` 之下 <col> 的宽度优先于单元格内容，于是表头 / 骨架行 / 真实行
 * 三者列宽逐像素一致：数据回来既不换列宽，也不会被长内容撑宽。
 */
export function TableColgroup({ columns }: { columns: readonly TableColumn[] }) {
  const total = columns.reduce((sum, c) => sum + c.width, 0)
  return (
    <colgroup>
      {columns.map((c) => (
        <col key={c.label} style={{ width: `${(c.width / total) * 100}%` }} />
      ))}
    </colgroup>
  )
}

/**
 * 表头：列宽声明 + `<thead>` 一起出（两者都必须是 `<table>` 的直接子节点，所以只能返回
 * 一个 Fragment）。加载态与数据态渲染的是同一个它 —— 顺序 / 文案 / 列宽只写一次，
 * 数据回来后表头不重建、列宽不重算。表头是静态文案，不受加载相位影响。
 */
export function TableHeader({ columns }: { columns: readonly TableColumn[] }) {
  return (
    <>
      {/* 列宽只声明一处：colgroup 之下表头 / 骨架行 / 真实行共用同一份宽度，谁也不靠内容定列宽 */}
      <TableColgroup columns={columns} />
      <thead>
        <tr>
          {columns.map(({ label, alignRight }) => (
            <th key={label} style={{ textAlign: alignRight ? 'right' : undefined }}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
    </>
  )
}

/**
 * 骨架行：只产出行，好注入真实表的 `<tbody>` —— 表头与 table 的 DOM 跨加载态保留，
 * 翻页 / 点查询 / 改每页条数时列宽与表头都不重建（变量页用法）。
 * `calm` 用于慢加载：给行挂一个类停掉扫光（见 .skeleton-calm），整表骨架也走这里。
 */
export function TableSkeletonRows({
  columns,
  rows = SKELETON_ROWS,
  calm = false,
}: {
  columns: readonly TableColumn[]
  rows?: number
  calm?: boolean
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, row) => (
        <tr key={row} className={calm ? 'skeleton-calm' : undefined} aria-hidden="true">
          {columns.map((c) => (
            <td key={c.label} className={c.td}>
              {c.skeleton?.(row)}
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/**
 * 加载播报：读屏器听不见 shimmer，得有人告诉它「正在加载…」。
 * 视觉上用 sr-only 藏起来 —— 骨架本身已经表达了「在加载」，再画一行字只是干扰。
 *
 * 默认文案保持形态中立（列表 / 卡片 / 整页都会用它），要更具体的说法由调用方传
 * `label`（如「正在加载变量数据…」）。
 *
 * 注意 aria-busy 不挂在这里：按 ARIA 规定 busy=true 会让辅助技术压后播报，
 * 正好把这句「开始加载」压到加载结束才念。busy 标在会变的那块内容上，播报交给这里。
 */
export function SkeletonLiveRegion({
  active,
  label = '正在加载…',
}: {
  active: boolean
  label?: string
}) {
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {active ? label : ''}
    </div>
  )
}

/**
 * 慢加载提示：超过阈值骨架已停扫光，这里补一句人话。有可点的重试才带按钮 ——
 * 整页骨架这类「没有重试动作」的场景只留话术，不给一个按了也没用的按钮。
 * 高度对齐分页条（14 + 30 + 14 + 上边框 = 59），顶替页脚时卡片不跳高；
 * 若它要横贯一张自带内边距的卡片，横向几何由调用方补（如 LogsPage 的 .slowNotice）。
 */
export function SkeletonSlowNotice({
  onRetry,
  className = '',
}: {
  /** 给了才画「重试」按钮 */
  onRetry?: () => void
  /** 位置修正（例如卡片内边距的负外边距） */
  className?: string
}) {
  return (
    <div className={`loading-slow ${className}`.trim()} role="status">
      <span>数据加载较慢，仍在等待…</span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

/** 页脚的三种形态：真页脚 / 骨架块 / （慢加载提示由 LoadingFooter 接管，这里只给它位置修正） */
export type LoadingFooterSlots = {
  /** 数据就位时的真页脚（分页条） */
  real: ReactNode
  /** 加载态占位：不给就当页脚一起藏起来 */
  skeleton?: ReactNode
  /** 慢加载提示的位置修正：它顶替的就是这个页脚，横向几何该跟页脚一致 */
  slowClassName?: string
}

/**
 * 页脚三态：慢加载提示 / 骨架块 / 真页脚。
 * 「错误 / 空态」由区域外壳负责**不渲染**它 —— 那两态整块都被占住了，
 * 页脚再出现只会让人以为还能翻页。
 * `footer.skeleton` 可不给：没准备骨架页脚的页面（如日志页）就当页脚一起藏起来，与原行为一致。
 * `footer.slowClassName` 是慢加载提示的位置修正 —— 它顶替的就是这个页脚，横向几何该跟页脚一致。
 */
export function LoadingFooter({
  phase,
  footer,
  onRetry,
}: {
  phase: LoadingPhase
  /** 真页脚（分页条）与它的骨架块；页面压根没有页脚时整个不给 */
  footer?: LoadingFooterSlots
  onRetry?: () => void
}) {
  if (phase.slow) {
    return <SkeletonSlowNotice onRetry={onRetry} className={footer?.slowClassName} />
  }
  if (!footer) return null
  return <>{phase.showSkeleton ? (footer.skeleton ?? null) : footer.real}</>
}

/**
 * 分页条占位：内层排布与真分页条一致（左右各一组控件），容器几何 —— 内边距 / 上边框 /
 * 负外边距 —— 由调用方把**真分页条那个类**传进来（`className`），因此高度和横向位置不可能
 * 与真分页条漂移，加载完换回真页脚时卡片不跳高。
 * 两块 188×30 对应「总数 / 每页条数」与页码控件。
 */
export function PagerSkeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`pager-skeleton ${className}`.trim()} aria-hidden="true">
      <SkeletonBox width={188} height={30} radius="var(--r-sm)" />
      <SkeletonBox width={188} height={30} radius="var(--r-sm)" />
    </div>
  )
}

/* ------------------------------------------------------------------ 原子件 */

/** 多行文字的宽度节奏：首行最长，交替收窄，末行留白更明显，看着更像真实文本 */
const TEXT_WIDTH_PATTERN = ['100%', '92%', '96%', '88%', '94%']
function textLineWidth(index: number, total: number): string {
  if (index === total - 1 && total > 1) return '62%'
  return TEXT_WIDTH_PATTERN[index % TEXT_WIDTH_PATTERN.length]
}

type SkeletonTextProps = {
  /** 行数；为 1 时直接输出单块，不多套一层容器 */
  lines?: number
  /** 行高：数字按 px，默认 12 */
  height?: number | string
  /** 行间距（仅多行生效，按 px），默认 8 */
  gap?: number
  /** 统一宽度；给了则所有行同宽，不给则用内置错落比例 */
  width?: number | string
  className?: string
  style?: CSSProperties
}

/**
 * 文字占位：一行或多行「文本条」。
 * 多行时自己决定各行宽度比例，避免调用方手写一堆积百分比。
 * 需要不同行高（如标题 + 副标题）时，用两个 SkeletonText 分别指定即可。
 */
export function SkeletonText({
  lines = 1,
  height = 12,
  gap = 8,
  width,
  className = '',
  style,
}: SkeletonTextProps) {
  if (lines <= 1) {
    return <Skeleton width={width ?? '100%'} height={height} className={className} style={style} />
  }
  return (
    <div
      className={`skeleton-text ${className}`.trim()}
      style={{ gap: `${gap}px`, ...style }}
      aria-hidden="true"
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={width ?? textLineWidth(i, lines)} height={height} />
      ))}
    </div>
  )
}

type SkeletonBoxProps = {
  /** 边长：数字按 px，字符串原样（如 '100%'），默认 40 —— 对齐列表里的图标盒 */
  size?: number | string
  /** 宽高分开指定，覆盖 size（如宽铺满、高固定） */
  width?: number | string
  height?: number | string
  /** 圆角：数字按 px，字符串原样；不给则沿用 .skeleton 的 --r-sm */
  radius?: number | string
  /** 正圆，等价 radius="50%"，用于头像 */
  round?: boolean
  className?: string
  style?: CSSProperties
}

/** 方形 / 圆形占位：图标盒、头像等「有明确边长」的块 */
export function SkeletonBox({
  size = 40,
  width,
  height,
  radius,
  round = false,
  className = '',
  style,
}: SkeletonBoxProps) {
  return (
    <Skeleton
      width={width ?? size}
      height={height ?? size}
      radius={round ? '50%' : radius}
      className={`skeleton-box ${className}`.trim()}
      style={style}
    />
  )
}

type SkeletonChipProps = {
  /** 宽度：数字按 px，默认 56 */
  width?: number | string
  /** 高度：数字按 px，默认 24（对齐全局 .chip） */
  height?: number | string
  className?: string
  style?: CSSProperties
}

/** 标签占位：胶囊形，对齐 .chip；行内小 chip 可通过 height 收窄 */
export function SkeletonChip({ width = 56, height = 24, className = '', style }: SkeletonChipProps) {
  return (
    <Skeleton
      width={width}
      height={height}
      radius={999}
      className={`skeleton-chip ${className}`.trim()}
      style={style}
    />
  )
}

type SkeletonButtonProps = {
  /** 宽度：数字按 px，默认 74 */
  width?: number | string
  /** 高度：数字按 px，默认 40（对齐 .btn 的 padding 9px + 13px 字号） */
  height?: number | string
  className?: string
  style?: CSSProperties
}

/** 按钮占位：尺寸对齐 .btn，圆角跟随 --r-md，避免动作区加载完跳高 */
export function SkeletonButton({
  width = 74,
  height = 40,
  className = '',
  style,
}: SkeletonButtonProps) {
  return (
    <Skeleton
      width={width}
      height={height}
      radius="var(--r-md)"
      className={`skeleton-button ${className}`.trim()}
      style={style}
    />
  )
}
