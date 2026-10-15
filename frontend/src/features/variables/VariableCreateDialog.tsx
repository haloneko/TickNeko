/**
 * 新增变量：只填「名字 + 类型（+ 它在哪个作用域）」，值随后在列表里点「编辑」填。
 *
 * - 类型清单来自后端 `GET /variables/types`：只列**建完能直接编辑**的类型，前端不抄一份；
 * - 作用域两档：账号级（归自己，归属由后端按登录用户填）/ 图级（必须选一张图，图来自工作流列表）；
 * - 建出来是**空变量**：本体不占存储键，但类型已经登记，所以空值不是 404，照样能查看与编辑；
 * - 变量名即身份：同名（已有本体 / 已登记类型 / 已被图里的节点声明）后端回 409 ——
 *   失败保留表单现场，把服务端文案原样显示出来。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { ApiRequestError } from '../../lib/http'
import { Modal } from '../../common/Modal'
import { IconPlus } from '../../common/icons'
import { listWorkflows, type WorkflowData } from '../workflow/workflowApi'
import {
  createVariable,
  listVariableTypes,
  VARIABLE_SCOPES,
  type VariableDraft,
  type VariableTypeOption,
} from './variablesApi'
import styles from './VariableCreateDialog.module.css'

/** 作用域的显示名：后端给机器值，界面上说人话（与列表页同一套说法）。 */
const SCOPE_LABELS: Record<string, string> = {
  graph: '图级（只属于某一张图）',
  account: '账号级（归自己，同账号共享）',
}

function describe(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback
}

export default function VariableCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  /** 建好了：把变量名交出去（页面负责提示与刷新），弹窗自己关 */
  onCreated: (key: string) => void
}) {
  const [types, setTypes] = useState<VariableTypeOption[]>([])
  const [graphs, setGraphs] = useState<WorkflowData[]>([])
  const [loadingOptions, setLoadingOptions] = useState(true)

  const [key, setKey] = useState('')
  const [typeId, setTypeId] = useState('')
  const [scope, setScope] = useState<string>('account')
  const [workflowId, setWorkflowId] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 打开弹窗时拉两份选项：能建哪些类型、能挂哪些图。拉不到就说清楚，别让人对着空下拉猜。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [typeList, graphList] = await Promise.all([listVariableTypes(), listWorkflows()])
        if (!alive) return
        setTypes(typeList.data)
        setTypeId(typeList.data[0]?.type_id ?? '')
        setGraphs(graphList.data)
        setWorkflowId(graphList.data[0]?.id ?? '')
      } catch (err) {
        if (alive) setError(describe(err, '选项没取到，关掉重开试试'))
      } finally {
        if (alive) setLoadingOptions(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const graphScope = scope === 'graph'

  async function submit(event: FormEvent) {
    event.preventDefault()
    const name = key.trim()
    setError('')
    // 前端先拦一遍明显的错（后端的判据仍是最后一关）：空名字、冒号、没选类型 / 图
    if (!name) {
      setError('变量名不能为空')
      return
    }
    if (name.includes(':')) {
      setError('变量名不能包含冒号')
      return
    }
    if (!typeId) {
      setError('请选择变量类型')
      return
    }
    if (graphScope && !workflowId) {
      setError('图级变量要选一张图')
      return
    }
    const draft: VariableDraft = {
      scope,
      key: name,
      typeId,
      ...(graphScope ? { workflowId } : {}),
    }
    setBusy(true)
    try {
      await createVariable(draft)
      onCreated(name)
    } catch (err) {
      setError(describe(err, '新建失败，请重试')) // 409（同名 / 被节点声明）也走这里
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="新增变量" onClose={onClose} busy={busy}>
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span className={styles.label}>变量名</span>
          <input
            className={styles.control}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="如 计数 / 日签开关"
            maxLength={80}
            autoFocus
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>变量类型</span>
          <select
            className={styles.control}
            value={typeId}
            disabled={loadingOptions}
            onChange={(event) => setTypeId(event.target.value)}
          >
            {types.length === 0 && (
              <option value="">{loadingOptions ? '读取中…' : '没有可新建的类型'}</option>
            )}
            {types.map((item) => (
              <option key={item.type_id} value={item.type_id}>
                {item.label ? `${item.label}（${item.type_id}）` : item.type_id}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>作用域</span>
          <select
            className={styles.control}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            {VARIABLE_SCOPES.map((item) => (
              <option key={item} value={item}>
                {SCOPE_LABELS[item] ?? item}
              </option>
            ))}
          </select>
        </label>

        {graphScope && (
          <label className={styles.field}>
            <span className={styles.label}>所属图</span>
            <select
              className={styles.control}
              value={workflowId}
              disabled={loadingOptions}
              onChange={(event) => setWorkflowId(event.target.value)}
            >
              {graphs.length === 0 && (
                <option value="">{loadingOptions ? '读取中…' : '还没有工作流'}</option>
              )}
              {graphs.map((graph) => (
                <option key={graph.id} value={graph.id}>
                  {graph.name}
                  {graph.owner_name ? ` · ${graph.owner_name}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        <p className={styles.hint}>
          新建出来的是空变量：先有名字和类型，值在列表里点「编辑」填。账号级变量归自己，同账号的
          工作流共用；图级只属于选中的那张图。同名变量只能有一个（想换类型先删除）。
        </p>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || loadingOptions}>
            <IconPlus size={15} />
            {busy ? '新建中…' : '新建'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
