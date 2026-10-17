/**
 * 运行日志页：GET /api/logs。
 *
 * 数据全部来自后端真实检索，前端不造任何一条日志：查不到就空态，接口挂了就错误态。
 * - 筛选（级别 / 模块 / 关键字 / 时间范围）点「查询」才生效，避免边打边请求；
 * - 管理员额外能选归属（全部 / 仅公共 / 具体某个人 —— 下拉直接列人，不用手敲 owner_id）
 *   与日志来源（落库 / 本机文件）；
 *   普通用户后端强制只返回自己名下的，UI 上直接不露出这两个条件；
 * - 响应带 total，底部走通用分页条（`common/Pagination`）：页码 + 首尾 / 上下页 + 跳页，
 *   每页条数 20/50/100/200；筛选条件 / 每页条数一变就回到第 1 页，数据变少时页码自动收口；
 * - 可选 10 秒自动刷新：静默重拉当前页（新日志本来就出现在最前），不闪骨架屏；
 * - 「清理历史日志」（POST /api/logs/clear）：只清**落库**的、**三天前**的（三天内后端
 *   一律拦下），走确认弹窗；普通用户只能清自己名下的，管理员可切「仅我名下的 / 全部日志」。
 *
 * 分页 / 防旧响应覆盖 / 错误归一 / 页码越界收口都在 `common/usePagedQuery`，这里只管
 * 筛选字段（草稿 vs 已生效）、展开态、自动刷新、清理范围，以及行怎么渲染。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { searchLogs, clearLogs, LOG_LEVELS, type LogEntry } from './logsApi'
import { fetchOwners, type Owner } from '../../lib/ownersApi'
import { useAuth } from '../auth/authStore'
import OwnerFilter, { ownerName } from '../../common/OwnerFilter'
import SelectMenu from '../../common/SelectMenu'
import { IconRefresh, IconChevronDown, IconAlert, IconClock, IconTrash } from '../../common/icons'
import { PagerSkeleton, SkeletonBox, SkeletonChip, SkeletonText } from '../../common/Skeleton'
import LoadingRegion from '../../common/LoadingRegion'
import { usePagedQuery } from '../../common/usePagedQuery'
import Pagination from '../../common/Pagination'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { useToast } from '../../common/Toast'
import { ApiRequestError } from '../../lib/http'
import styles from './LogsPage.module.css'

/** 每页条数可选项；后端单次上限 500，这里给几档常用值。 */
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const
/** 默认每页条数。 */
const DEFAULT_PAGE_SIZE = 50
/** 自动刷新间隔（毫秒）。 */
const AUTO_REFRESH_MS = 10_000

/** 级别徽标的配色键，样式按 data-level 走 CSS。 */
type Filters = {
  level: string
  query: string
  loggerName: string
  startTime: string // datetime-local 原值
  endTime: string
  /** 归属：`all` = 全部；`public` = 只看公共；其余值就是归属 id（下拉直接列人） */
  owner: string
  source: 'database' | 'local' | 'both'
}

const EMPTY_FILTERS: Filters = {
  level: '',
  query: '',
  loggerName: '',
  startTime: '',
  endTime: '',
  owner: 'all',
  source: 'database',
}

/** datetime-local（本地时区）→ Unix 秒字符串；空 / 非法返回 undefined。 */
function toUnix(value: string): string | undefined {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : undefined
}

function formatTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—'
  const d = new Date(unixSeconds * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 来源选项 -> 后端的来源**类别**（source）：出口叫什么名字由装配层定，前端不写死名字。 */
const SOURCE_PARAMS: Record<Filters['source'], string | undefined> = {
  database: undefined, // 不写 source，后端默认就只查落库那份
  local: 'file', // 本机文件 = 所有文件出口（核心 file / 接口层 api.file / OneBot onebot.file）
  both: 'all', // 两边都要 = 不限出口（库 + 文件一起查）
}

/* 占位条高度取真实文本的行盒高度（字号 × 全局 line-height 1.6），同高才不跳行 */
const LOG_META_LINE = 19 // .time 12px × 1.6 ≈ 19.2
const LOG_MESSAGE_LINE = 22 // .message 13.5px × 1.6 ≈ 21.6

/**
 * 骨架列表：结构与真实行逐项对齐 —— 同样是 `<ul>` / `<li>`，同样挂 `styles.list` /
 * `row`，行内复用 `rowToggle` / `rowMain` / `rowMeta`，间距、内边距与分隔线因此全部
 * 由真实 CSS 决定，只有内容换成原子占位。
 *
 * 真实行里 `hasDetail` 才画的折叠箭头、以及 `exc_text` 才有的「异常栈」标记，
 * 都取决于具体条目，占位里不画（不影响行高，只差右侧 16px 图标）。
 */
function LogsListSkeleton({ rows = 6, isAdmin }: { rows?: number; isAdmin: boolean }) {
  return (
    <ul className={styles.list} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className={styles.row} aria-hidden="true">
          {/* 真实行这里是 button；占位不可点，只借它的版式 */}
          <div className={`${styles.rowToggle} ${styles.rowToggleSkeleton}`}>
            {/* 64×26、圆角 6 对齐 .levelBadge（等宽字体级别徽标） */}
            <SkeletonBox width={64} height={26} radius={6} />
            <div className={styles.rowMain}>
              <div className={styles.rowMeta}>
                <SkeletonText width={104} height={LOG_META_LINE} />
                {/* 96×22、圆角 5 对齐 .logger（等宽模块名小胶囊） */}
                <SkeletonBox width={96} height={22} radius={5} />
                {/* 归属胶囊与真实行同条件：只有管理员看得到 */}
                {isAdmin && <SkeletonChip width={64} height={22} />}
              </div>
              <SkeletonText width={`${48 + ((i * 17) % 34)}%`} height={LOG_MESSAGE_LINE} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function LogsPage() {
  const { state } = useAuth()
  const isAdmin = !!state.user?.roles.includes('admin')

  // 表单草稿（输入中）与已生效查询（点「查询」后才同步）
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  /** 可选归属：归属下拉直接列人（管理员才用得上；拉不到就只剩「全部 / 仅公共」） */
  const [owners, setOwners] = useState<Owner[]>([])
  /** 清理范围（仅管理员可选）：own = 只清自己名下的；all = 全部（含公共） */
  const [clearScope, setClearScope] = useState<'own' | 'all'>('own')
  /** 待确认的清理目标：非 null 时弹确认框（破坏性操作先过一道确认） */
  const [clearTarget, setClearTarget] = useState<'own' | 'all' | null>(null)
  const [clearing, setClearing] = useState(false)
  const { pushToast } = useToast()

  const patchDraft = (patch: Partial<Filters>) =>
    setDraft((prev) => ({ ...prev, ...patch }))

  /** 把已生效筛选翻译成后端参数：limit/offset 由 hook 按页码算好，这里只塞筛选字段。 */
  const buildParams = useCallback(
    (filters: Filters, base: { limit: number; offset: number }) => {
      const params: Record<string, string | number> = { ...base }
      if (filters.level) params.level = filters.level
      const q = filters.query.trim()
      if (q) params.query = q
      const logger = filters.loggerName.trim()
      if (logger) params.logger_name = logger
      const start = toUnix(filters.startTime)
      if (start !== undefined) params.start = start
      const end = toUnix(filters.endTime)
      if (end !== undefined) params.end = end
      if (isAdmin) {
        // 归属三态：all = 不传（全部）；public = 空串（只看公共）；其余就是归属 id
        if (filters.owner === 'public') params.owner_id = ''
        else if (filters.owner !== 'all') params.owner_id = filters.owner
        const source = SOURCE_PARAMS[filters.source]
        if (source) params.source = source
      }
      return params
    },
    [isAdmin],
  )

  const query = usePagedQuery<LogEntry, Filters>({
    applied,
    buildParams,
    fetchPage: (params) => searchLogs(params).then((res) => res.data),
    defaultPageSize: DEFAULT_PAGE_SIZE,
    fallbackErrorTitle: '日志加载失败',
    notAvailableTitle: '这个来源查不了',
  })

  // 自动刷新：固定间隔静默重拉当前页（不闪骨架屏，失败也不清列表）
  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      query.refresh(true)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, query.refresh])

  function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    setExpandedId(null)
    query.setPage(1) // 条件变了就从第 1 页看起
    setApplied({ ...draft })
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS)
    setExpandedId(null)
    query.setPage(1)
    setApplied({ ...EMPTY_FILTERS })
  }

  /** 跳到某页：清掉展开态（页码一变 hook 就会去拉那一页）。 */
  function goToPage(target: number) {
    setExpandedId(null)
    query.setPage(target)
  }

  /** 改每页条数：清掉展开态并回到第 1 页（否则 offset 会落到不存在的位置）。 */
  function changePageSize(size: number) {
    setExpandedId(null)
    query.setPageSize(size)
  }

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (draft.level) n++
    if (draft.query.trim()) n++
    if (draft.loggerName.trim()) n++
    if (draft.startTime) n++
    if (draft.endTime) n++
    if (isAdmin) {
      if (draft.owner !== 'all') n++
      if (draft.source !== 'database') n++
    }
    return n
  }, [draft, isAdmin])

  // 归属下拉的选项（只有管理员用得上）：拉一次就够，失败也不影响查日志
  useEffect(() => {
    if (!isAdmin) return
    void fetchOwners()
      .then(({ data }) => setOwners(data))
      .catch(() => undefined)
  }, [isAdmin])

  /** 执行清理：只清落库的、三天前的；范围按角色定（普通用户后端强制只清自己的）。 */
  async function runClear() {
    if (!clearTarget) return
    setClearing(true)
    try {
      const params: { owner_id?: string } = {}
      // 管理员选「仅我名下的」就显式带自己的归属；其余（普通用户 / 管理员选全部）不传，
      // 后端按角色决定（普通用户强制自己，管理员清全部含公共）
      if (clearTarget === 'own' && isAdmin) params.owner_id = state.user?.id ?? ''
      const result = await clearLogs(params)
      pushToast('success', `已清理 ${result.data.deleted} 条三天前的日志`)
      setClearTarget(null)
      query.refresh(true)
    } catch (err) {
      pushToast('error', err instanceof ApiRequestError ? err.message : '清理失败')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>运行日志</h1>
          <p className={styles.sub}>
            检索框架落库的运行日志，按写入顺序倒序（最新的在最前）。
            {isAdmin
              ? '你是管理员，可以查看所有人的日志、切换来源，并清理三天前的历史日志。'
              : '普通账号只显示自己名下的日志，可清理自己三天前的历史日志。'}
          </p>
        </div>
        <div className={styles.headActions}>
          <label className={styles.autoToggle}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <IconClock size={15} />
            10 秒自动刷新
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => query.refresh(false)}
            disabled={query.loading}
          >
            <IconRefresh size={15} className={query.loading ? styles.spin : undefined} />
            刷新
          </button>
          {isAdmin && (
            <select
              className={styles.clearScope}
              value={clearScope}
              onChange={(e) => setClearScope(e.target.value as 'own' | 'all')}
              aria-label="清理范围"
            >
              <option value="own">仅我名下的</option>
              <option value="all">全部日志</option>
            </select>
          )}
          <button
            type="button"
            className={`btn btn-danger ${styles.clearBtn}`}
            onClick={() => setClearTarget(clearScope)}
            disabled={clearing}
            title="只清理落库的、三天前的日志（三天内的删不掉）"
          >
            <IconTrash size={15} />
            {isAdmin ? '清理三天前' : '清理我的三天前'}
          </button>
        </div>
      </header>

      {/* 清理确认：破坏性操作先过一道（只清落库、只清三天前，文案写清楚再让动手） */}
      {clearTarget && (
        <ConfirmDialog
          title={
            clearTarget === 'all' ? '清理全部三天前的日志？' : '清理三天前的日志？'
          }
          body={
            <>
              只清理<strong>落库</strong>的、<strong>三天前</strong>的日志
              {clearTarget === 'all' ? '（含所有账号名下与公共的）' : '（你名下的）'}
              ；三天内的不会动，清理不可恢复。
            </>
          }
          confirmText="清理"
          busy={clearing}
          onCancel={() => setClearTarget(null)}
          onConfirm={() => void runClear()}
        />
      )}

      {/* 筛选栏 */}
      <form className={`card ${styles.filterCard}`} onSubmit={submitSearch}>
        <div className={styles.filterGrid}>
          <SelectMenu
            layout="vertical"
            label="级别"
            value={draft.level}
            onChange={(level) => patchDraft({ level })}
            options={[
              { value: '', label: '全部级别' },
              ...LOG_LEVELS.map((lv) => ({ value: lv, label: lv })),
            ]}
          />

          <label className={styles.field}>
            <span className={styles.fieldLabel}>关键字（正文模糊）</span>
            <input
              className={styles.control}
              type="text"
              value={draft.query}
              placeholder="如 登录 / 吊销 / trace"
              onChange={(e) => patchDraft({ query: e.target.value })}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>模块（精确）</span>
            <input
              className={styles.control}
              type="text"
              value={draft.loggerName}
              placeholder="如 tickneko.api、tickneko.bridge、tickneko.onebot"
              onChange={(e) => patchDraft({ loggerName: e.target.value })}
            />
          </label>

          {isAdmin && (
            <>
              <OwnerFilter
                owners={owners}
                value={draft.owner}
                onChange={(owner) => patchDraft({ owner })}
                allValue="all"
                allLabel="全部归属"
                extraOptions={[{ value: 'public', label: '仅公共日志' }]}
                renderAlways
                layout="vertical"
              />

              <SelectMenu
                layout="vertical"
                label="来源"
                value={draft.source}
                onChange={(source) => patchDraft({ source: source as Filters['source'] })}
                options={[
                  { value: 'database', label: '落库（默认）' },
                  { value: 'local', label: '本机文件' },
                  { value: 'both', label: '落库 + 本机文件' },
                ]}
              />
            </>
          )}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>开始时间</span>
            <input
              className={styles.control}
              type="datetime-local"
              value={draft.startTime}
              onChange={(e) => patchDraft({ startTime: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>结束时间</span>
            <input
              className={styles.control}
              type="datetime-local"
              value={draft.endTime}
              onChange={(e) => patchDraft({ endTime: e.target.value })}
            />
          </label>
        </div>

        <div className={styles.filterActions}>
          <button type="submit" className="btn btn-primary" disabled={query.loading}>
            查询
          </button>
          <button
            type="button"
            className="btn"
            onClick={resetFilters}
            disabled={query.loading || activeFilterCount === 0}
          >
            重置
          </button>
          {activeFilterCount > 0 && (
            <span className={styles.filterCount}>已加 {activeFilterCount} 个条件</span>
          )}
        </div>
      </form>

      {/* 结果区：骨架 / 空态 / 错误 / 页脚四态交给 LoadingRegion，
          相位（250ms 延迟、9s 慢加载停扫光 + 重试、读屏播报）由它自己管 */}
      <section className={`card ${styles.listCard}`}>
        <LoadingRegion
          loading={query.loading}
          error={query.error}
          isEmpty={query.items.length === 0}
          onRetry={() => query.refresh(false)}
          liveLabel="正在加载运行日志…"
          skeleton={<LogsListSkeleton isAdmin={isAdmin} />}
          empty={
            <div className="state-box">
              <IconAlert size={18} className={styles.stateIcon} />
              没有符合条件的日志
            </div>
          }
          footer={{
            real: (
              <Pagination
                page={query.page}
                pageSize={query.pageSize}
                total={query.total}
                onChange={goToPage}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={changePageSize}
                disabled={query.loading}
                className={styles.pager}
              />
            ),
            // 骨架页脚顶住分页条的位置：改前加载时整条页脚消失，卡片会先矮一截再长回来
            skeleton: <PagerSkeleton className={styles.pager} />,
            // 慢加载提示顶替的就是分页条：横向几何照抄（分页条靠负外边距撑满卡片）
            slowClassName: styles.slowNotice,
          }}
        >
          <ul className={styles.list}>
            {query.items.map((entry) => {
              const hasDetail =
                !!entry.exc_text || Object.keys(entry.extra).length > 0
              const expanded = expandedId === entry.record_id
              return (
                <li
                  key={entry.record_id}
                  className={`${styles.row} ${expanded ? styles.rowExpanded : ''}`}
                >
                  <button
                    type="button"
                    className={styles.rowToggle}
                    disabled={!hasDetail}
                    onClick={() =>
                      setExpandedId((id) => (id === entry.record_id ? null : entry.record_id))
                    }
                    aria-expanded={expanded}
                  >
                    <span className={styles.levelBadge} data-level={entry.level}>
                      {entry.level}
                    </span>
                    <span className={styles.rowMain}>
                      <span className={styles.rowMeta}>
                        <span className={styles.time}>{formatTime(entry.timestamp)}</span>
                        <span className={styles.logger}>{entry.logger_name || '—'}</span>
                        {isAdmin && (
                          <span
                            className={`${styles.ownerChip} ${
                              entry.owner_id ? '' : styles.ownerPublic
                            }`}
                            title={entry.owner_id || '公共（框架自身的日志，没有归属）'}
                          >
                            {entry.owner_id ? ownerName(entry.owner_id, owners) : '公共'}
                          </span>
                        )}
                        {!!entry.exc_text && <span className={styles.excFlag}>异常栈</span>}
                      </span>
                      <span className={styles.message}>{entry.message}</span>
                    </span>
                    {hasDetail && (
                      <IconChevronDown
                        size={16}
                        className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
                      />
                    )}
                  </button>

                  {expanded && hasDetail && (
                    <div className={styles.detail}>
                      {entry.exc_text && (
                        <pre className={styles.excText}>{entry.exc_text}</pre>
                      )}
                      {Object.keys(entry.extra).length > 0 && (
                        <pre className={styles.extraJson}>
                          {JSON.stringify(entry.extra, null, 2)}
                        </pre>
                      )}
                      <div className={styles.recordId}>
                        {entry.seq > 0 && <>seq · {entry.seq} · </>}
                        record_id · {entry.record_id}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </LoadingRegion>
      </section>
    </div>
  )
}
