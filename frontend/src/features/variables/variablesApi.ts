/**
 * 变量查看 API：GET /api/variables。
 *
 * 与后端契约一一对应（见 tickneko/api/api/variables/router.py）：
 * - 响应是一页 `{ items, total }`，total 是命中总数，前端据此算总页数、做页码跳转；
 * - 变量按作用域分两档：`graph`（图级，只有这张图看得见）/ `account`（账号级，同账号共享）；
 * - 非管理员后端强制只看自己的 owner_id，指定别人会 403 —— 所以普通用户不传 owner_id；
 * - 列表接口只列元数据：value/data/length 为空，看内容走 /variables/value（viewVariable）；
 * - 缓存没接入时后端回 503（变量全在缓存里，没有它答不了）。
 */
import { http } from '../../lib/http'

/** 变量作用域（后端口径）。顺序即界面下拉顺序。 */
export const VARIABLE_SCOPES = ['graph', 'account'] as const
export type VariableScope = (typeof VARIABLE_SCOPES)[number]

/** 一个工作流变量：字段原样来自后端，不做二次拼串。 */
export interface VariableEntry {
  /** 作用域：graph = 图级；account = 账号级 */
  scope: VariableScope | string
  /** 归属者 id；空串 = 查不到归属（图已被删） */
  owner_id: string
  /** 所属工作流 id；账号级变量为空串 */
  workflow_id: string
  /** 所属工作流名；图级才有，图被删查不到则空串 */
  workflow_name: string
  /** 变量名 */
  key: string
  /** 兼容旧只读调用方的文本预览（列表接口只列元数据，value 为空串） */
  value: string
  /** 查看器的展示类型，与存储类型无关 */
  type: 'json' | 'list' | 'dict' | 'str' | null
  /** 查看器注册时自带的中文名；空串 = 未注册（前端按 type 兜底） */
  type_label: string
  data: unknown
  /** list 本体长度 */
  length: number | null
  editable: boolean
  reason: string
  /** 剩余秒数；null = 永不过期 */
  ttl: number | null
}

/** 变量列表的一页：本页条目 + 命中总数（总数只跟筛选条件有关）。 */
export interface VariablePage {
  items: VariableEntry[]
  total: number
}

/** 查询参数：全部可选；字段名即后端 query 参数名。 */
export interface VariableSearchParams {
  /** 归属者精确匹配（仅管理员有意义；普通用户后端强制只看自己，传了也不生效） */
  owner_id?: string
  /** 作用域：graph / account；不传 = 全部 */
  scope?: string
  /** 变量名模糊匹配 */
  query?: string
  limit?: number
  offset?: number
}

/** 列出变量（只含元数据，不读本体值；看内容请走 viewVariable）。params 里 undefined 的字段不发。 */
export function listVariables(params: VariableSearchParams = {}) {
  return http.get<VariablePage>('/variables', { params })
}

/** 修改字段由节点查看器定义；扩展字段完整交给服务端校验。 */
export type VariableMutation = Record<string, unknown>

function variableIdentity(entry: VariableEntry): Record<string, string> {
  return entry.scope === 'account'
    ? { scope: 'account', owner_id: entry.owner_id, key: entry.key }
    : { scope: 'graph', workflow_id: entry.workflow_id, key: entry.key }
}

export function viewVariable(entry: VariableEntry) {
  return http.get<VariableEntry>('/variables/value', { params: variableIdentity(entry) })
}

export function addVariable(entry: VariableEntry, params: VariableMutation) {
  const identity = new URLSearchParams(variableIdentity(entry))
  return http.post<VariableEntry>(`/variables/add?${identity}`, params)
}

/** 类型名的兜底映射：只在查看器**没注册**名字时用（新查看器请在后端注册 label）。 */
const TYPE_LABELS: Record<string, string> = {
  str: '文本',
  json: 'JSON',
  list: '列表',
  dict: '字典',
}

/**
 * 界面上显示的类型名：**优先用查看器注册的那份**（后端下发），
 * 好区分同一个 type 下不同节点的结构（如「列表」与「列表·计数」）。
 */
export function typeLabel(entry: VariableEntry): string {
  return entry.type_label || (entry.type ? TYPE_LABELS[entry.type] ?? entry.type : '')
}
