/** 工作流列表：新建 / 查看 / 发布 / 删除；点编辑弹出全屏画布编辑器。
 *
 * 「新建」是列表卡片右上角那个按钮（点开一个只要名字的小弹窗），不再单独占一块面板 ——
 * 一块列表 + 一个动作，比上下并排两块好看也更好找。
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  deleteWorkflow,
  listWorkflows,
  publishWorkflow,
  renameWorkflow,
  setWorkflowEnabled,
  type WorkflowData,
} from './workflowApi'
import { fetchOwners, type Owner } from '../../lib/ownersApi'
import { ApiRequestError } from '../../lib/http'
import { useToast } from '../../common/Toast'
import OwnerFilter, { ownerName } from '../../common/OwnerFilter'
import { useAuth } from '../auth/authStore'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { EmptyState } from '../../common/EmptyState'
import {
  BADGE_H,
  SkeletonBox,
  SkeletonChip,
  SkeletonText,
  TEXT_H,
  type TableColumn,
} from '../../common/Skeleton'
import TableFrame from '../../common/TableFrame'
import {
  IconEdit,
  IconPlus,
  IconPublish,
  IconRefresh,
  IconRename,
  IconSettings,
  IconTrash,
} from '../../common/icons'
import WorkflowCreateDialog from './WorkflowCreateDialog'
import WorkflowEditor from './WorkflowEditor'
import WorkflowSettingsDialog from './WorkflowSettingsDialog'
import styles from './WorkflowPage.module.css'

function describe(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return '请求失败'
}

function formatTime(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusLabel(w: WorkflowData): { text: string; cls: string } {
  if (w.status === 'published') return { text: '已发布', cls: styles.published }
  return { text: '草稿', cls: styles.draft }
}

/* 占位高度（TEXT_H / BADGE_H）与表头都来自 common/Skeleton：变量页是同一套表格版式，
   两页共用一份「层高」与「列宽 + 表头」的机制，只有列配置各自保留。 */

/* 操作列是 5 个纯图标按钮（编辑 / 设置 / 重命名 / 发布最新版 / 删除）。尺寸与间距不另立一套，
   直接取公共 .icon-btn 与 .rowActions 的值，骨架就照这两个数铺 —— 按钮换了大小（原来是带
   文案的 .btn，宽 74~100）骨架自动跟上，不会在骨架里留一份旧尺寸。 */
const ACTIONS = 5
const ACTION_ICON = 38 // .icon-btn 的边长
const ACTION_GAP = 4 // .rowActions 的 gap

/**
 * 表头列：真实表与骨架表共用同一份 —— 顺序 / 文案 / 列宽 / 骨架占位都不可能再漂移。
 * `width` 是列宽权重（各列之和 = .table 的 min-width），交给 TableColgroup 归一成百分比
 * 写进 `<col>`；配合 `.table` 的 `table-layout: fixed`，列宽就不再由内容决定：数据回来后
 * 既不换列宽，也不会被长名字 / 5 个图标按钮把表撑宽。权重取「表头 + 内边距 36」与真实内容
 * 需要量的较大者；`skeleton(row)` 是这一列的占位，宽度按真实内容的量级取。
 */
const COLUMNS: TableColumn[] = [
  {
    label: '所有者', // 名字短、id 截尾（旧的 max-width 是 180）；骨架条 max 68
    width: 130,
    td: styles.ownerCell,
    skeleton: (i) => <SkeletonText width={48 + (i % 3) * 10} height={TEXT_H} />,
  },
  {
    label: '名称', // 最宽的数据列，长名字截尾；骨架条 max 136
    width: 240,
    td: styles.nameCell,
    skeleton: (i) => <SkeletonText width={96 + ((i * 13) % 40)} height={TEXT_H} />,
  },
  {
    label: '状态', // 胶囊「已发布」58
    width: 100,
    // 两种胶囊宽度对应「已发布 / 草稿」
    skeleton: (i) => <SkeletonChip width={i % 2 ? 46 : 58} height={BADGE_H} />,
  },
  {
    label: '运行', // 开关 38 + 间距 8 + 文案 36 = 82
    width: 128,
    skeleton: () => (
      <span className={styles.skelSwitch}>
        {/* 38×22 是公共 .switch 的轨道尺寸，它不是一个文字条，故不并入 TEXT_H */}
        <SkeletonChip width={38} height={22} />
        <SkeletonText width={36} height={TEXT_H} />
      </span>
    ),
  },
  // 表头「当前版本」48 比「v12」还宽，按表头算
  { label: '当前版本', width: 96, skeleton: () => <SkeletonText width={22} height={TEXT_H} /> },
  { label: '发布版本', width: 96, skeleton: () => <SkeletonText width={22} height={TEXT_H} /> },
  {
    label: '更新时间', // 「2026-10-16 01:26」一行放得下，不折行
    width: 168,
    td: styles.muted,
    skeleton: () => <SkeletonText width={104} height={TEXT_H} />,
  },
  {
    label: '操作', // 5 个图标按钮 + 4 个间距 = 222，加单元格左右内边距 36
    width: ACTIONS * ACTION_ICON + (ACTIONS - 1) * ACTION_GAP + 36,
    alignRight: true,
    skeleton: () => (
      <div className={styles.rowActions}>
        {Array.from({ length: ACTIONS }).map((_, j) => (
          // 占位就是按钮本身的尺寸（38 方形、--r-sm 圆角），不是默认那个 40/--r-md 的按钮占位
          <SkeletonBox key={j} size={ACTION_ICON} radius="var(--r-sm)" />
        ))}
      </div>
    ),
  },
]

export default function WorkflowPage() {
  const { pushToast } = useToast()
  const { state } = useAuth()
  /** 自己的归属 id：新建出来的流永远归它（后端按登录用户落库，不认前端传的归属） */
  const myId = state.user?.id ?? ''

  const [items, setItems] = useState<WorkflowData[]>([])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState('')
  /** 新建弹窗开着没有（列表右上角那个按钮控制它） */
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  /** 打开设置弹窗的那条工作流（null = 没开） */
  const [settingsFor, setSettingsFor] = useState<WorkflowData | null>(null)
  /** 可选归属：归属列的显示名与筛选下拉都用它（普通用户只会拿到自己那一条） */
  const [owners, setOwners] = useState<Owner[]>([])
  /** 筛选中的归属 id；空串 = 全部（下拉只在选项有两个以上时出现） */
  const [ownerFilter, setOwnerFilter] = useState('')

  /** 能不能新建：只看「全部」或自己的归属 —— 切到别人的归属时建的还是自己名下的，别给这种错觉 */
  const canCreate = ownerFilter === '' || ownerFilter === myId

  const load = useCallback(async () => {
    setLoading(true)
    setFailure('')
    try {
      // 归属清单与列表一起取：它同时供归属列显示名与筛选下拉用
      const [list, ownerList] = await Promise.all([listWorkflows(ownerFilter), fetchOwners()])
      setItems(list.data)
      setOwners(ownerList.data)
    } catch (err) {
      setFailure(describe(err))
    } finally {
      setLoading(false)
    }
  }, [ownerFilter])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(id: string) {
    setBusy(true)
    try {
      await deleteWorkflow(id)
      pushToast('success', '工作流已删除')
      setConfirmId(null)
      await load()
    } catch (err) {
      pushToast('error', describe(err))
    } finally {
      setBusy(false)
    }
  }

  async function commitRename(id: string) {
    const value = renameValue.trim()
    const current = items.find((w) => w.id === id)?.name
    setRenameId(null)
    if (!value || value === current) return
    setBusy(true)
    try {
      const { data } = await renameWorkflow(id, value)
      pushToast('success', `已改名为「${data.name}」`)
      setItems((list) => list.map((w) => (w.id === id ? data : w)))
    } catch (err) {
      pushToast('error', describe(err))
    } finally {
      setBusy(false)
    }
  }

  /** 拨**运行开关**：发布 ≠ 运行 —— 拨开才真的按已发布版本跑（默认关）。 */
  async function toggleEnabled(w: WorkflowData) {
    const next = !w.enabled
    setBusy(true)
    try {
      const { data } = await setWorkflowEnabled(w.id, next)
      pushToast('success', next ? `已开启：${w.name}` : `已停止：${w.name}`)
      setItems((list) => list.map((item) => (item.id === data.id ? data : item)))
    } catch (err) {
      pushToast('error', describe(err))  // 还没发布过就拨开：后端 409
    } finally {
      setBusy(false)
    }
  }

  async function publish(id: string) {
    setBusy(true)
    try {
      await publishWorkflow(id)
      pushToast('success', '最新版本已发布')
      await load()
    } catch (err) {
      pushToast('error', describe(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rise">
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>工作流</h2>
          <p className={styles.desc}>
            用节点 + 连线编排自动化流程：开始节点支持时间触发（cron）与消息触发，
            搭配日志 / 测试等节点，校验通过后保存版本，发布即生效。
          </p>
        </div>
        <button
          className="icon-btn"
          onClick={() => void load()}
          disabled={loading}
          title="刷新"
          aria-label="刷新"
        >
          <IconRefresh size={16} />
        </button>
      </header>

      {failure && <div className={styles.failure}>{failure}</div>}

      <section className={`card ${styles.panel}`}>
        <div className={styles.panelHead}>
          <div className={styles.panelHeadText}>
            <h3 className={styles.panelTitle}>工作流列表</h3>
          </div>
          <div className={styles.panelActions}>
            <OwnerFilter owners={owners} value={ownerFilter} onChange={setOwnerFilter} />
            {canCreate && (
              // 这是主操作，所以用实心的 icon-btn-primary，不是幽灵那颗
              <button
                className="icon-btn icon-btn-primary"
                onClick={() => setCreating(true)}
                title="新建工作流"
                aria-label="新建工作流"
              >
                <IconPlus size={16} />
              </button>
            )}
          </div>
        </div>
        {/* 列表区整体是横向滚动容器：列宽由表头权重定死（见 COLUMNS / .table），
            窄屏靠这里滚，而不是让 .panel 的 overflow: hidden 把右侧「操作」裁掉。
            加载 / 空 / 页脚三态交给 TableFrame：表格壳与表头跨加载态保留，只换 tbody 的行。
            只有 `failure` 不交给它 —— 那条红条是「列表没拉到」的补充提示，位置在面板上方，
            允许与上一次的内容同时出现，不是「替掉内容」的错误态。 */}
        <TableFrame
          columns={COLUMNS}
          tableClassName={styles.table}
          wrapClassName={styles.tableWrap}
          loading={loading}
          isEmpty={items.length === 0}
          onRetry={() => void load()}
          liveLabel="正在加载工作流数据…"
          empty={
            <EmptyState
              icon={IconEdit}
              title={canCreate ? '还没有工作流' : '这个归属下还没有工作流'}
              hint={
                canCreate
                  ? '用节点 + 连线编排自动化流程：开始节点支持时间触发（cron）与消息触发，搭配日志 / 测试节点。'
                  : '切回「全部」或自己的归属才能新建；别人名下的流只能查看与编辑。'
              }
              action={
                canCreate ? (
                  <button className="btn btn-primary" onClick={() => setCreating(true)}>
                    <IconPlus size={15} />
                    新建工作流
                  </button>
                ) : undefined
              }
            />
          }
        >
          {items.map((w) => {
            const st = statusLabel(w)
            return (
              <tr key={w.id}>
                {/* 归属：普通用户只有自己一份，管理员看的是全库 —— 名字撞车时靠它认人 */}
                <td className={styles.ownerCell} title={w.owner_id}>
                  {/* 后端已给 owner_name；万一它是空串（老数据 / 没设昵称）就用归属清单兜底 */}
                  {w.owner_name || ownerName(w.owner_id, owners)}
                </td>
                <td className={styles.nameCell} title={w.name}>
                  {renameId === w.id ? (
                    <input
                      autoFocus
                      className={styles.renameInput}
                      value={renameValue}
                      maxLength={128}
                      disabled={busy}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename(w.id)
                        if (e.key === 'Escape') setRenameId(null)
                      }}
                      onBlur={() => setRenameId(null)}
                    />
                  ) : (
                    w.name
                  )}
                </td>
                <td>
                  <span className={`chip ${st.cls}`}>{st.text}</span>
                </td>
                <td>
                  <label
                    className={styles.switch}
                    title={
                      w.published_version === 0
                        ? '先发布一版，才能拨运行开关'
                        : w.enabled
                          ? '点一下停止：不再定时触发（发布状态不变）'
                          : '点一下开启：按已发布版本跑'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      disabled={busy || w.published_version === 0}
                      onChange={() => void toggleEnabled(w)}
                    />
                    <span className={`switch ${w.enabled ? 'switch-on' : ''}`}>
                      <span className="switch-knob" />
                    </span>
                    <span className={styles.switchText}>
                      {w.enabled ? '运行中' : '已停止'}
                    </span>
                  </label>
                </td>
                <td>v{w.current_version}</td>
                <td>{w.published_version > 0 ? `v${w.published_version}` : '—'}</td>
                <td className={styles.muted}>{formatTime(w.updated_at)}</td>
                <td>
                  <div className={styles.rowActions}>
                    {/* 纯图标：文案进 title（悬停看）与 aria-label（读屏器听），
                        两者都写 —— 只给 title 的话键盘 focus 与触屏都拿不到名字 */}
                    <button
                      className="icon-btn"
                      disabled={busy}
                      onClick={() => setEditingId(w.id)}
                      title="编辑"
                      aria-label="编辑"
                    >
                      <IconEdit size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      disabled={busy}
                      onClick={() => setSettingsFor(w)}
                      title="设置"
                      aria-label="设置"
                    >
                      <IconSettings size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      disabled={busy || renameId === w.id}
                      onClick={() => {
                        setRenameId(w.id)
                        setRenameValue(w.name)
                      }}
                      title="重命名"
                      aria-label="重命名"
                    >
                      <IconRename size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      disabled={busy || w.current_version === 0}
                      onClick={() => void publish(w.id)}
                      // 灰着的时候说明为什么灰着（同「运行」开关那颗 title 的做法）
                      title={w.current_version === 0 ? '还没有版本可发布' : '发布最新版'}
                      aria-label="发布最新版"
                    >
                      <IconPublish size={16} />
                    </button>
                    <button
                      className="icon-btn icon-btn-danger"
                      disabled={busy}
                      onClick={() => setConfirmId(w.id)}
                      title="删除"
                      aria-label="删除"
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </TableFrame>
      </section>

      {/* 删除不可逆：统一走确认弹窗 */}
      {confirmId && (
        <ConfirmDialog
          title="删除这个工作流？"
          body={
            <>
              删除 <b>{items.find((w) => w.id === confirmId)?.name ?? '这个工作流'}</b>
              ：它的暂存区、全部版本与发布记录一并删掉，不可恢复（正在运行时也会随之停掉）。
            </>
          }
          confirmText="删除"
          busy={busy}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => void remove(confirmId)}
        />
      )}

      {creating && (
        <WorkflowCreateDialog
          onClose={() => setCreating(false)}
          onCreated={() => void load()}
        />
      )}

      {editingId && createPortal(
        <WorkflowEditor
          workflowId={editingId}
          onClose={() => {
            setEditingId(null)
            void load()
          }}
        />,
        document.body,
      )}

      {settingsFor && createPortal(
        <WorkflowSettingsDialog
          workflow={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSaved={(updated) => {
            // 就地替换列表里那一行：设置没动图的指针，不必整页重拉
            setItems((list) => list.map((item) => (item.id === updated.id ? updated : item)))
          }}
        />,
        document.body,
      )}
    </div>
  )
}
