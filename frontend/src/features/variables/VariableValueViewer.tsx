/** 按查看器展示类型渲染、编辑和调用 add；保存后重新读取，失败保留草稿。
 * 列表行只带元信息（不读本体值），点「查看 / 编辑」打开弹窗时才拉详情。 */
import { useMemo, useRef, useState } from 'react'
import { FullscreenDialog } from '../../common/FullscreenDialog'
import { ConfirmDialog } from '../../common/ConfirmDialog'
import { JsonEditor, type JsonEditorHandle } from '../../common/JsonEditor'
import { IconCheck, IconCopy, IconEdit, IconEye, IconPlus, IconTrash } from '../../common/icons'
import { ApiRequestError } from '../../lib/http'
import {
  addVariable,
  typeLabel,
  viewVariable,
  type VariableEntry,
  type VariableMutation,
} from './variablesApi'
import {
  dictFromJson,
  dictPayload,
  dictToJsonText,
  draftValue,
  listFromJson,
  listPayload,
  listToJsonText,
  parseValue,
  type FieldDraft,
  type ValueDraft,
} from './variableEdits'
import styles from './VariableValueViewer.module.css'

const emptyValue = (): ValueDraft => ({ text: '', format: 'text' })

function shown(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '（空字符串）' : value
  return JSON.stringify(value, null, 2) ?? 'null'
}

function recordData(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
}

function Preview({ entry, expanded = false }: { entry: VariableEntry; expanded?: boolean }) {
  const className = `${styles.preview} ${expanded ? styles.expanded : ''}`
  switch (entry.type) {
    case 'list': {
      const items: unknown[] = Array.isArray(entry.data) ? entry.data : []
      const visible = expanded ? items : items.slice(0, 4)
      return (
        <div className={className}>
          {items.length === 0 ? (
            '（空列表）'
          ) : (
            <ol className={styles.list}>
              {visible.map((item, index) => (
                <li key={index}>{shown(item)}</li>
              ))}
            </ol>
          )}
          {!expanded && items.length > visible.length && (
            <span className={styles.hint}>还有 {items.length - visible.length} 项</span>
          )}
        </div>
      )
    }
    case 'dict': {
      const fields = Object.entries(recordData(entry.data))
      const visible = expanded ? fields : fields.slice(0, 4)
      return (
        <div className={className}>
          {fields.length === 0 ? (
            '（空字典）'
          ) : (
            <dl className={styles.dictionary}>
              {visible.map(([field, value]) => (
                <div key={field} style={{ display: 'contents' }}>
                  <dt>{field}</dt>
                  <dd>{shown(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {!expanded && fields.length > visible.length && (
            <span className={styles.hint}>还有 {fields.length - visible.length} 个字段</span>
          )}
        </div>
      )
    }
    case 'json':
      return <pre className={className}>{JSON.stringify(entry.data, null, 2)}</pre>
    case 'str':
      return <div className={className}>{shown(entry.data)}</div>
    default:
      return <span className={styles.hint}>{entry.reason || '暂不支持查看'}</span>
  }
}

/** 复制一段文本到系统剪贴板：优先 clipboard API；非安全上下文（http + 局域网 IP）
 * 没有它就退回临时 textarea + execCommand，保证本机 / 局域网访问都能用。 */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // 没有权限 / 不可用：落到下面的兜底
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-9999px'
  document.body.appendChild(area)
  try {
    area.select()
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择后复制')
  } finally {
    document.body.removeChild(area)
  }
}

/** 删除第 index 行后，正在编辑的行号跟着挪位（被删的那行直接退出编辑）。 */
function shiftRowAfterRemove(index: number): (row: number | null) => number | null {
  return (row) => (row === null || row === index ? null : row < index ? row : row - 1)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请重试'
}

function clearsCollection(params: VariableMutation): boolean {
  return (
    (Array.isArray(params.items) && params.items.length === 0) ||
    ('fields' in params &&
      params.fields !== null &&
      typeof params.fields === 'object' &&
      Object.keys(params.fields).length === 0)
  )
}

export default function VariableValueViewer({
  entry,
  onChanged,
  className = '',
}: {
  entry: VariableEntry
  onChanged: () => void
  /** 挂在根容器上的类名：列表把它塞进表格操作列时用来控制对齐 */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState(entry)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dirty, setDirty] = useState(false)
  const [text, setText] = useState('')
  const [items, setItems] = useState<ValueDraft[]>([])
  const [fields, setFields] = useState<FieldDraft[]>([])
  // 双视图：list / dict 可在「逐项表单」与「整体 JSON」间切换，保存以最后编辑的视图为准
  const [viewMode, setViewMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState('')
  // 未保存草稿时点关闭，先弹确认再真正关
  const [pendingClose, setPendingClose] = useState(false)
  // list / dict 表单视图的过滤定位（按值文本或字段名），只收窄显示、不动草稿
  const [filter, setFilter] = useState('')
  // dict 行默认只读展示，点「修改」才让这一行变成输入框（点「完成」退出）
  const [editingRow, setEditingRow] = useState<number | null>(null)
  // 刚新增的那一行：挂载后自动聚焦它的输入框（autoFocus 只在挂载时生效）
  const [focusRow, setFocusRow] = useState<number | null>(null)
  // CodeMirror 实例句柄：json 类型与 list/dict JSON 视图各一个，用于格式化
  const jsonTypeRef = useRef<JsonEditorHandle>(null)
  const jsonViewRef = useRef<JsonEditorHandle>(null)

  function applySnapshot(snapshot: VariableEntry, keepView = false) {
    setCurrent(snapshot)
    setText(
      snapshot.type === 'str' && typeof snapshot.data === 'string'
        ? snapshot.data
        : (JSON.stringify(snapshot.data, null, 2) ?? 'null'),
    )
    setItems(
      Array.isArray(snapshot.data) && snapshot.type === 'list' ? snapshot.data.map(draftValue) : [],
    )
    setFields(
      snapshot.type === 'dict'
        ? Object.entries(recordData(snapshot.data)).map(([field, value]) => ({
            field,
            value: draftValue(value),
          }))
        : [],
    )
    setFilter('')
    setEditingRow(null)
    setFocusRow(null)
    setDirty(false)
    setJsonError('')
    if (keepView) return
    setViewMode('form')
    setJsonText('')
  }

  async function load() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      applySnapshot((await viewVariable(entry)).data)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
      busyRef.current = false
    }
  }

  function showEditor() {
    applySnapshot(entry)
    setOpen(true)
    void load()
  }

  async function modify(params: VariableMutation) {
    if (busyRef.current || !current.editable) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = (await addVariable(entry, params)).data
      let latest: VariableEntry
      try {
        latest = (await viewVariable(entry)).data
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404 && clearsCollection(params)) {
          // 空集合不占存储键；来源也丢失时保留成功保存的空快照，并刷新列表。
          latest = { ...saved, editable: false, reason: '变量已清空，节点重新写入后可继续编辑' }
        } else {
          setError(`已保存，但重新读取失败：${errorMessage(err)}`)
          onChanged()
          return
        }
      }
      applySnapshot(latest, true) // 保存后停在当前视图：JSON 标签不会被切回表单
      setNotice('已保存')
      onChanged()
    } catch (err) {
      setError(errorMessage(err)) // 包括服务端 422；不重置任何编辑草稿。
    } finally {
      setBusy(false)
      busyRef.current = false
    }
  }

  function save() {
    try {
      switch (current.type) {
        case 'str':
          void modify({ value: text })
          break
        case 'json':
          void modify({ value: parseValue({ text, format: 'json' }) })
          break
        case 'list':
          void modify(viewMode === 'json' ? { items: listFromJson(jsonText) } : listPayload(items))
          break
        case 'dict':
          void modify(
            viewMode === 'json' ? { fields: dictFromJson(jsonText) } : dictPayload(fields),
          )
          break
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  /** 表单 → JSON：以当前草稿为准生成文本，切过去继续改，不丢已做的修改。 */
  function toJsonView() {
    setJsonText(current.type === 'list' ? listToJsonText(items) : dictToJsonText(fields))
    setJsonError('')
    setViewMode('json')
  }

  /** JSON → 表单：先校验，JSON 无效就拦住并保留现场，避免草稿被错误内容覆盖。 */
  function toFormView() {
    try {
      if (current.type === 'list') {
        setItems(listFromJson(jsonText).map(draftValue))
      } else {
        setFields(
          Object.entries(dictFromJson(jsonText)).map(([field, value]) => ({
            field,
            value: draftValue(value),
          })),
        )
      }
      setJsonError('')
      setViewMode('form')
    } catch (err) {
      setJsonError(errorMessage(err))
    }
  }

  /** 表单视图过滤：list 按值文本，dict 按字段名+值；保留原始编号定位，不影响草稿。 */
  const visibleItems = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const all = items.map((item, index) => ({ item, index }))
    return q ? all.filter(({ item }) => item.text.toLowerCase().includes(q)) : all
  }, [filter, items])

  const visibleFields = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const all = fields.map((field, index) => ({ field, index }))
    return q
      ? all.filter(
          ({ field }) =>
            field.field.toLowerCase().includes(q) || field.value.text.toLowerCase().includes(q),
        )
      : all
  }, [filter, fields])

  /** 新增：直接在表格末尾追加一行空草稿，并把焦点落到新行。
   *
   * list 追加空值（表格里直接改）；dict 追加空键空值并进入编辑态。随保存一次全量提交
   * （后端 `items`/`fields` 覆盖语义不变）。 */
  function add() {
    if (current.type === 'list') {
      setFocusRow(items.length)
      setItems((values) => [...values, emptyValue()])
    } else {
      setFocusRow(fields.length)
      setEditingRow(fields.length)
      setFields((values) => [...values, { field: '', value: emptyValue() }])
    }
    setFilter('') // 有过滤时新行会被藏起来，这里清掉过滤让新行可见
    edited()
  }

  /** 清空整份集合的草稿（保存后才真正落库）。 */
  function clearCollection() {
    if (current.type === 'list') setItems([])
    else setFields([])
    setEditingRow(null)
    edited()
  }

  function edited() {
    setDirty(true)
    setNotice('')
    setError('')
  }

  /** 行内「复制」：把这一行的内容送进系统剪贴板，成功 / 失败都反馈到状态栏。 */
  async function copyRow(text: string, label: string) {
    try {
      await copyText(text)
      setNotice(`已复制${label}`)
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className={className}>
      {/* 行内这条工具栏不能带外边距（rowToolbar）：它长在表格单元格里，
          那 8px 上下边距会把整行从 64 顶到 80.8；弹窗里那条仍用 toolbar */}
      <div className={`${styles.toolbar} ${styles.rowToolbar}`}>
        {entry.type && (
          <button
            type="button"
            className="icon-btn"
            onClick={showEditor}
            title={
              entry.editable
                ? '编辑'
                : entry.reason
                  ? `查看（不可编辑：${entry.reason}）`
                  : '查看'
            }
            aria-label={entry.editable ? '编辑变量' : '查看变量'}
          >
            {entry.editable ? <IconEdit size={16} /> : <IconEye size={16} />}
          </button>
        )}
      </div>
      {open && (
        <FullscreenDialog
          title={
            <>
              变量 · {entry.key}
              {current.type && (
                <span className={styles.typeBadge}>{typeLabel(current)}</span>
              )}
            </>
          }
          tabs={
            current.editable && (current.type === 'list' || current.type === 'dict') ? (
              <div className={styles.viewTabs}>
                <button
                  type="button"
                  className={viewMode === 'form' ? styles.tabActive : undefined}
                  onClick={toFormView}
                >
                  表单
                </button>
                <button
                  type="button"
                  className={viewMode === 'json' ? styles.tabActive : undefined}
                  onClick={toJsonView}
                >
                  JSON
                </button>
              </div>
            ) : undefined
          }
          actions={
            <>
              <button
                type="button"
                className="btn"
                disabled={busy || dirty}
                onClick={() => void load()}
              >
                刷新
              </button>
              {(current.type === 'json' ||
                (viewMode === 'json' && (current.type === 'list' || current.type === 'dict'))) && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    if (current.type === 'json') jsonTypeRef.current?.format()
                    else jsonViewRef.current?.format()
                  }}
                >
                  格式化
                </button>
              )}
              {current.editable && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  title="保存（Ctrl/Cmd+S）"
                  onClick={save}
                >
                  {busy ? '提交中…' : '保存'}
                </button>
              )}
            </>
          }
          status={
            <>
              {current.type && (
                <span>
                  {typeLabel(current)}
                  {current.type === 'list' && current.length !== null
                    ? ` · 当前 ${current.length} 项`
                    : ''}
                </span>
              )}
              {dirty && <span className={styles.dirty}>● 未保存</span>}
              {busy && <span role="status">处理中…</span>}
              {notice && <span role="status">{notice}</span>}
              {error && (
                <span className={styles.error} role="alert">
                  {error}
                </span>
              )}
            </>
          }
          // Ctrl/Cmd+S 直接保存；只读变量不给快捷键，别把浏览器「保存网页」拦了却没动作
          onSave={current.editable ? save : undefined}
          busy={busy}
          onClose={() => {
            if (dirty && current.editable) setPendingClose(true)
            else setOpen(false)
          }}
        >
          {!current.editable ? (
            <div className={styles.padded}>
              <p className={styles.hint}>{current.reason}</p>
              <Preview entry={current} expanded />
            </div>
          ) : (
            // 纯编辑器（str / json / list·dict 的 JSON 视图）铺满全屏；表单视图留白
            <fieldset
              disabled={busy}
              className={`${styles.editor}${
                viewMode === 'form' && (current.type === 'list' || current.type === 'dict')
                  ? ` ${styles.padded}`
                  : ''
              }`}
            >
              {current.type === 'str' && (
                <JsonEditor
                  value={text}
                  onChange={(value) => {
                    setText(value)
                    edited()
                  }}
                  ariaLabel="变量值"
                  mode="text"
                  minHeight={260}
                />
              )}
              {current.type === 'json' && (
                <JsonEditor
                  ref={jsonTypeRef}
                  value={text}
                  onChange={(value) => {
                    setText(value)
                    edited()
                  }}
                  ariaLabel="变量 JSON"
                  minHeight={460}
                />
              )}
              {viewMode === 'json' && (current.type === 'list' || current.type === 'dict') && (
                <>
                  {jsonError && (
                    <p className={styles.error} role="alert">
                      {jsonError}
                    </p>
                  )}
                  <JsonEditor
                    ref={jsonViewRef}
                    value={jsonText}
                    onChange={(value) => {
                      setJsonText(value)
                      setJsonError('')
                      edited()
                    }}
                    ariaLabel="变量 JSON"
                    minHeight={460}
                  />
                </>
              )}
              {viewMode === 'form' && (current.type === 'list' || current.type === 'dict') && (
                <div className={styles.toolbar}>
                  <input
                    className={`${styles.control} ${styles.filter}`}
                    type="search"
                    placeholder={current.type === 'list' ? '过滤元素…' : '过滤字段名或值…'}
                    aria-label="过滤"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  {filter.trim() && (
                    <span className={styles.hint}>
                      显示 {current.type === 'list' ? visibleItems.length : visibleFields.length}/
                      {current.type === 'list' ? items.length : fields.length} 项
                    </span>
                  )}
                  <button type="button" className="btn" onClick={add}>
                    <IconPlus size={14} />
                    新增
                  </button>
                  <button type="button" className="btn" onClick={clearCollection}>
                    <IconTrash size={14} />
                    清空
                  </button>
                </div>
              )}
              {current.type === 'list' && viewMode === 'form' && (
                <>
                  {items.length === 0 && <p className={styles.hint}>空列表</p>}
                  {filter.trim() && visibleItems.length === 0 && (
                    <p className={styles.hint}>没有匹配的元素</p>
                  )}
                  {visibleItems.length > 0 && (
                    <table className={styles.grid}>
                      <thead>
                        <tr>
                          <th className={styles.gridNo}>#</th>
                          <th>值</th>
                          <th className={styles.gridOps}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleItems.map(({ item, index }) => (
                          <tr key={index}>
                            <td className={styles.gridNo}>{index + 1}</td>
                            <td>
                              <input
                                className={styles.control}
                                aria-label={`第 ${index + 1} 项`}
                                autoFocus={index === focusRow}
                                value={item.text}
                                onChange={(event) => {
                                  const next = event.target.value
                                  setItems((values) =>
                                    values.map((old, i) =>
                                      i === index ? { ...old, text: next } : old,
                                    ),
                                  )
                                  edited()
                                }}
                              />
                            </td>
                            <td className={styles.gridOps}>
                              <button
                                type="button"
                                className={styles.iconBtn}
                                title="复制到剪贴板"
                                aria-label={`复制第 ${index + 1} 项`}
                                onClick={() => void copyRow(item.text, `第 ${index + 1} 项`)}
                              >
                                <IconCopy size={14} />
                              </button>
                              <button
                                type="button"
                                className={`${styles.iconBtn} ${styles.iconDanger}`}
                                title="删除"
                                aria-label={`删除第 ${index + 1} 项`}
                                onClick={() => {
                                  setItems((values) => values.filter((_, i) => i !== index))
                                  edited()
                                }}
                              >
                                <IconTrash size={14} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
              {current.type === 'dict' && viewMode === 'form' && (
                <>
                  {fields.length === 0 && <p className={styles.hint}>空字典</p>}
                  {filter.trim() && visibleFields.length === 0 && (
                    <p className={styles.hint}>没有匹配的字段</p>
                  )}
                  {visibleFields.length > 0 && (
                    <table className={styles.grid}>
                      <thead>
                        <tr>
                          <th className={styles.gridNo}>#</th>
                          <th>键</th>
                          <th>值</th>
                          <th className={styles.gridOps}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleFields.map(({ field, index }) => {
                          const editing = editingRow === index
                          return (
                            <tr key={index} className={editing ? styles.rowEditing : undefined}>
                              <td className={styles.gridNo}>{index + 1}</td>
                              <td>
                                {editing ? (
                                  <input
                                    className={styles.control}
                                    aria-label={`字段 ${index + 1} 的名称`}
                                    autoFocus={index === focusRow}
                                    value={field.field}
                                    onChange={(event) => {
                                      const name = event.target.value
                                      setFields((values) =>
                                        values.map((old, i) =>
                                          i === index ? { ...old, field: name } : old,
                                        ),
                                      )
                                      edited()
                                    }}
                                  />
                                ) : (
                                  <span className={styles.cellText}>
                                    {field.field || '（空名）'}
                                  </span>
                                )}
                              </td>
                              <td>
                                {editing ? (
                                  <input
                                    className={styles.control}
                                    aria-label={`字段 ${index + 1} 的值`}
                                    value={field.value.text}
                                    onChange={(event) => {
                                      const text = event.target.value
                                      setFields((values) =>
                                        values.map((old, i) =>
                                          i === index
                                            ? { ...old, value: { ...old.value, text } }
                                            : old,
                                        ),
                                      )
                                      edited()
                                    }}
                                  />
                                ) : (
                                  <span className={styles.cellText}>
                                    {field.value.text === '' ? '（空字符串）' : field.value.text}
                                  </span>
                                )}
                              </td>
                              <td className={styles.gridOps}>
                                <button
                                  type="button"
                                  className={styles.iconBtn}
                                  title="复制到剪贴板"
                                  aria-label={`复制字段 ${index + 1}`}
                                  onClick={() =>
                                    void copyRow(`${field.field}=${field.value.text}`, `字段 ${index + 1}`)
                                  }
                                >
                                  <IconCopy size={14} />
                                </button>
                                <button
                                  type="button"
                                  className={styles.iconBtn}
                                  title={editing ? '完成' : '修改'}
                                  aria-label={
                                    editing ? `完成字段 ${index + 1}` : `修改字段 ${index + 1}`
                                  }
                                  onClick={() => setEditingRow(editing ? null : index)}
                                >
                                  {editing ? <IconCheck size={14} /> : <IconEdit size={14} />}
                                </button>
                                <button
                                  type="button"
                                  className={`${styles.iconBtn} ${styles.iconDanger}`}
                                  title="删除"
                                  aria-label={`删除字段 ${index + 1}`}
                                  onClick={() => {
                                    setFields((values) => values.filter((_, i) => i !== index))
                                    setEditingRow(shiftRowAfterRemove(index))
                                    edited()
                                  }}
                                >
                                  <IconTrash size={14} />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </fieldset>
          )}
        </FullscreenDialog>
      )}
      {pendingClose && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          body={<>关闭后草稿会丢弃，已保存的部分不受影响。</>}
          confirmText="放弃修改"
          onCancel={() => setPendingClose(false)}
          onConfirm={() => {
            setPendingClose(false)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}
