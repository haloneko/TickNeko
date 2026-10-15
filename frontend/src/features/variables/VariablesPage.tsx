/**
 * 变量查看页：GET /api/variables。
 *
 * 查看节点拥有的变量，并由 VariableValueViewer 编辑（口径见 docs/variables/variables.md）：
 * - 作用域分两档：图级（只有某一张图看得见）/ 账号级（同一账号的工作流共享）；
 * - **权限在服务端**：管理员看得到所有人的变量，可以用归属下拉筛到某一个人；
 *   普通用户后端强制只返回自己名下的，界面上直接不露出归属那一项 —— 前端不做「假权限」。
 * - 页头「新增变量」走 `VariableCreateDialog`：只建「名字 + 类型」的空变量，值随后在行内编辑；
 *
 * 数据全部来自后端真实检索，前端不造一条变量：查不到就空态，接口挂了就错误态。
 * 筛选（作用域 / 变量名 / 归属）点「查询」才生效，避免边打边请求。
 *
 * 分页 / 防旧响应覆盖 / 错误归一 / 页码越界收口都在 `common/usePagedQuery`，这里只管
 * 筛选字段（草稿 vs 已生效）、归属下拉，以及行怎么渲染。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteVariable,
  listVariables,
  typeLabel,
  VARIABLE_SCOPES,
  type VariableEntry,
} from './variablesApi'
import { fetchOwners, type Owner } from '../../lib/ownersApi'
import { ApiRequestError } from '../../lib/http'
import { useAuth } from '../auth/authStore'
import OwnerFilter, { ownerName } from '../../common/OwnerFilter'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { IconPlus, IconRefresh, IconTrash, IconVariables } from '../../common/icons'
import { ListSkeleton } from '../../common/Skeleton'
import ErrorBox from '../../common/ErrorBox'
import { usePagedQuery } from '../../common/usePagedQuery'
import { useToast } from '../../common/Toast'
import Pagination from '../../common/Pagination'
import styles from './VariablesPage.module.css'
import VariableCreateDialog from './VariableCreateDialog'
import VariableValueViewer from './VariableValueViewer'

/** 每页条数可选项（后端单次上限 500）。 */
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const
/** 默认每页条数。 */
const DEFAULT_PAGE_SIZE = 50

/** 作用域的显示名：后端给机器值，界面上说人话。 */
const SCOPE_LABELS: Record<string, string> = {
  graph: '图级',
  account: '账号级',
}

type Filters = {
  /** 作用域：空串 = 全部 */
  scope: string
  /** 变量名模糊匹配 */
  query: string
  /** 归属：`all` = 全部（仅管理员）；其余值是归属 id */
  owner: string
}

const EMPTY_FILTERS: Filters = { scope: '', query: '', owner: 'all' }

/** 剩余有效期：null / 非有限值 = 不过期；秒数按其量级换成人话。 */
function formatTtl(ttl: number | null): string {
  if (ttl === null || !Number.isFinite(ttl)) return '不过期'
  if (ttl < 60) return `剩 ${Math.round(ttl)} 秒`
  if (ttl < 3600) return `剩 ${Math.round(ttl / 60)} 分钟`
  if (ttl < 86400) return `剩 ${(ttl / 3600).toFixed(1)} 小时`
  return `剩 ${(ttl / 86400).toFixed(1)} 天`
}

export default function VariablesPage() {
  const { state } = useAuth()
  const { pushToast } = useToast()
  const isAdmin = !!state.user?.roles.includes('admin')

  /** 待删除的变量：非空就弹确认框（破坏性操作统一走 ConfirmDialog） */
  const [pendingDelete, setPendingDelete] = useState<VariableEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  /** 新增变量弹窗：开关 + 建好后的提示与刷新 */
  const [createOpen, setCreateOpen] = useState(false)

  // 表单草稿（输入中）与已生效查询（点「查询」后才同步）
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)

  /** 可选归属：归属下拉直接列人（只有管理员用得上；拉不到就只剩「全部归属」） */
  const [owners, setOwners] = useState<Owner[]>([])

  const patchDraft = (patch: Partial<Filters>) => setDraft((prev) => ({ ...prev, ...patch }))

  /** 把已生效筛选翻译成后端参数：limit/offset 由 hook 按页码算好，这里只塞筛选字段。 */
  const buildParams = useCallback(
    (filters: Filters, base: { limit: number; offset: number }) => {
      // 列表接口只列元数据：行内不摊开内容，点「查看 / 编辑」才单独拉详情
      const params: Record<string, string | number> = { ...base }
      if (filters.scope) params.scope = filters.scope
      const q = filters.query.trim()
      if (q) params.query = q
      // 归属只有管理员能选；普通用户不传 —— 服务端本来也只给他自己的
      if (isAdmin && filters.owner !== 'all') params.owner_id = filters.owner
      return params
    },
    [isAdmin],
  )

  const query = usePagedQuery<VariableEntry, Filters>({
    applied,
    buildParams,
    fetchPage: (params) => listVariables(params).then((res) => res.data),
    defaultPageSize: DEFAULT_PAGE_SIZE,
    fallbackErrorTitle: '变量加载失败',
    notAvailableTitle: '变量看不了',
  })

  function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    query.setPage(1) // 条件变了就从第 1 页看起
    setApplied({ ...draft })
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS)
    query.setPage(1)
    setApplied({ ...EMPTY_FILTERS })
  }

  /** 删除不可逆：确认后调接口，成功刷新列表；失败展示服务端文案（404 = 已被别人删掉）。 */
  async function removeVariable(entry: VariableEntry) {
    setDeleting(true)
    try {
      await deleteVariable(entry)
      pushToast('success', `已删除变量「${entry.key}」`)
      setPendingDelete(null)
      void query.refresh(true)
    } catch (err) {
      pushToast('error', err instanceof ApiRequestError ? err.message : '删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (draft.scope) n++
    if (draft.query.trim()) n++
    if (isAdmin && draft.owner !== 'all') n++
    return n
  }, [draft, isAdmin])

  // 归属下拉的选项（只有管理员用得上）：拉一次就够，失败也不影响查变量
  useEffect(() => {
    if (!isAdmin) return
    void fetchOwners()
      .then(({ data }) => setOwners(data))
      .catch(() => undefined)
  }, [isAdmin])

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>变量查看</h1>
          <p className={styles.sub}>
            查看和编辑工作流节点写入的变量：图级只属于某一张图，账号级在同一账号的工作流之间共享。
            {isAdmin
              ? '你是管理员，可以查看所有人的变量并按归属筛选。'
              : '普通账号只显示自己名下的变量。'}
          </p>
        </div>
        <div className={styles.headActions}>
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <IconPlus size={15} />
            新增变量
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => query.refresh(false)}
            disabled={query.loading}
          >
            <IconRefresh size={15} className={query.loading ? styles.spin : undefined} />
            刷新
          </button>
        </div>
      </header>

      {/* 筛选栏 */}
      <form className={`card ${styles.filterCard}`} onSubmit={submitSearch}>
        <div className={styles.filterGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>作用域</span>
            <select
              className={styles.control}
              value={draft.scope}
              onChange={(e) => patchDraft({ scope: e.target.value })}
            >
              <option value="">全部作用域</option>
              {VARIABLE_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {SCOPE_LABELS[scope] ?? scope}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>变量名（模糊）</span>
            <input
              className={styles.control}
              type="text"
              value={draft.query}
              placeholder="如 计数 / 日签开关"
              onChange={(e) => patchDraft({ query: e.target.value })}
            />
          </label>

          {isAdmin && (
            <OwnerFilter
              owners={owners}
              value={draft.owner}
              onChange={(owner) => patchDraft({ owner })}
              allValue="all"
              allLabel="全部归属"
              renderAlways
              layout="vertical"
            />
          )}
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

      {/* 结果区 */}
      <section className={`card ${styles.listCard}`}>
        {query.loading ? (
          <ListSkeleton rows={6} />
        ) : query.error ? (
          <ErrorBox error={query.error} onRetry={() => query.refresh(false)} />
        ) : query.items.length === 0 ? (
          <div className="state-box">
            <IconVariables size={18} className={styles.stateIcon} />
            没有符合条件的变量
          </div>
        ) : (
          <>
            {/* 表格样式与工作流页一致：作用域 / 变量名 / 类型 / 归属 / 所属图 / 有效期 / 操作 */}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>作用域</th>
                    <th>变量名</th>
                    <th>类型</th>
                    {isAdmin && <th>归属</th>}
                    <th>所属图</th>
                    <th>有效期</th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {query.items.map((entry) => (
                    <tr
                      key={`${entry.scope}:${entry.owner_id}:${entry.workflow_id}:${entry.key}`}
                    >
                      <td>
                        <span className={styles.scopeBadge} data-scope={entry.scope}>
                          {SCOPE_LABELS[entry.scope] ?? entry.scope}
                        </span>
                      </td>
                      <td className={styles.keyCell} title={entry.key}>
                        {entry.key}
                      </td>
                      <td>
                        {entry.type ? (
                          <span className={`chip ${styles.typeTag}`}>{typeLabel(entry)}</span>
                        ) : (
                          <span className={styles.muted}>—</span>
                        )}
                      </td>
                      {isAdmin && (
                        <td
                          className={`${styles.ownerCell} ${
                            entry.owner_id ? '' : styles.ownerUnknown
                          }`}
                          title={entry.owner_id || '查不到归属（图可能已被删）'}
                        >
                          {entry.owner_id ? ownerName(entry.owner_id, owners) : '无归属'}
                        </td>
                      )}
                      <td className={styles.graphCell}>
                        {entry.workflow_id ? (
                          <span
                            className={styles.graphName}
                            title={`图 id：${entry.workflow_id}`}
                          >
                            {entry.workflow_name || entry.workflow_id}
                          </span>
                        ) : (
                          <span className={styles.muted}>—</span>
                        )}
                      </td>
                      <td className={styles.ttl}>{formatTtl(entry.ttl)}</td>
                      <td>
                        <div className={styles.rowActions}>
                          {entry.type && (
                            <VariableValueViewer
                              entry={entry}
                              onChanged={() => query.refresh(true)}
                              className={styles.viewerCell}
                            />
                          )}
                          <button
                            type="button"
                            className="btn btn-danger-ghost"
                            disabled={deleting}
                            title="删除这个变量"
                            onClick={() => setPendingDelete(entry)}
                          >
                            <IconTrash size={14} />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={query.page}
              pageSize={query.pageSize}
              total={query.total}
              onChange={query.setPage}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageSizeChange={query.setPageSize}
              disabled={query.loading}
              className={styles.pager}
            />
          </>
        )}
      </section>

      {/* 新增变量：只建名字 + 类型（值随后在行内点「编辑」填），建好了静默刷新列表 */}
      {createOpen && (
        <VariableCreateDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(key) => {
            setCreateOpen(false)
            pushToast('success', `已新建变量「${key}」，点「编辑」填值`)
            void query.refresh(true)
          }}
        />
      )}

      {/* 删除不可逆：统一走确认弹窗 */}
      {pendingDelete && (
        <ConfirmDialog
          title="删除这个变量？"
          body={
            <>
              删除 <b>{pendingDelete.key}</b>
              ：它的值会被一并清掉，图 / 账号下的其它变量不受影响。删除不可恢复，
              节点下次运行会重新写入。
            </>
          }
          confirmText="删除"
          busy={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void removeVariable(pendingDelete)}
        />
      )}
    </div>
  )
}
