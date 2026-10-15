# 变量中枢、查看器与键族联动

变量查看 / 编辑由写变量的节点拥有。`NodeSpec.variable_viewer` 声明一个 `VariableViewer`
子类，查看器负责匹配规则、只读探测、编码、参数校验、存储读写和展示数据。HTTP 入口只做
身份定位、鉴权、分派与响应封装；前端只认识 `json / list / dict / str` 四种展示类型。

## 1. 模块与调用链

| 文件 | 职责 |
|---|---|
| `tickneko/variables/keys.py` | **键布局的唯一实现处**：`VariableKey`（本体 / 属性表 / 节点私有段） |
| `tickneko/variables/viewer.py` | `VariableContext`、`VariableRule`、`VariableView`、`VariableViewer` 契约与类型注册表（「认识的类型」与「有节点维护的类型」两份名单） |
| `tickneko/variables/viewers.py` | 显式注册的 str / json / list / dict 基础查看器（基类与兜底探测，没有节点声明它们） |
| `tickneko/variables/center.py` | `VariableCenter`：用户目录、属性表、**唯一写入口** `write_variable`（守卫→写→报到）、类型墓碑（弹空≠删除）、显式 `drop` 注销 |
| `tickneko/workflow/nodes/base.py` | `NodeSpec.variable_viewer`（默认 `None`）；`ctx.variable()` / `ctx.write_variable()`（内置写节点统一走它） |
| `tickneko/workflow/nodes/registry.py` | 三种节点注册入口均收集查看器；同类去重、类型 id 去重，顺序确定 |
| `tickneko/workflow/nodes/cache.py` | `CacheViewer`，匹配 cache 的 `set` 动作 |
| `tickneko/workflow/nodes/ds_dict.py` | `DsDictViewer`，字典文本编码与完整覆盖 |
| `tickneko/workflow/nodes/ds_container.py` | `DsListViewer` 与运行时共用的本体 / 频次联动 |
| `tickneko/api/services/variables/service.py` | 逻辑变量发现、图来源反查、登记类型 / 探测与查看器选择、按类型新建 |
| `tickneko/api/api/variables/router.py`、`responses.py` | HTTP 入口、错误转换与通用响应壳 |
| `frontend/src/features/variables/` | 类型渲染、编辑草稿、新建变量弹窗、元素新增 / 保存与重新读取 |

调用链：`VariablesPage → VariableValueViewer → variablesApi → router → VariableService →
节点注册的查看器 → 节点拥有的存储实现`。工作流层不 import FastAPI，中枢不认识工作流模型
（只读来源节点的 `config`），核心缓存层不依赖工作流。

## 2. 注册、反查与探测

`register_node`、`register_executor`、`declare_node_type` 都接受
`variable_viewer=SomeViewer`，并顺带把它的 `type_id` 登记进类型注册表（一个 `type_id`
只能属于一个类）。查看器定义 `type_id`、`label`、`rules`、`priority`、`match(context)`、
只读的 `probe(context)`、`view()` 和 `add(self, /, **params)`。

类型注册表分两份名单，用途不同：

* `registered_variable_viewers()`：**本进程认识**的全部类型（含 `str / json / list / dict`
  这几个只作基类与兜底的基础类型）—— 用来**解读**已有变量（探测、按登记类型查看）；
* `node_variable_viewers()`：**有节点在维护**的类型 —— 节点**带执行器**注册时随查看器一起
  登记（`register_executor` / `register_node`）；只 `declare_node_type` 占位、执行器还没写的
  类型不算。用来**开新变量**（见第 4 节「新建」）：没人写的类型建出来也没人动。

上下文只由服务端创建：包含缓存连接、中枢、作用域、真实归属、图 id、逻辑名称、来源节点，
以及**用户目录里登记的变量类型** `type_id`。物理键由可信身份计算，请求体里的
`owner_id / key / context` 等字段不能改变它。

图级变量优先检查已发布的图快照；没有发布版本时检查当前提交版本，再检查未提交图的暂存区。
默认规则匹配节点配置中的 `scope / key`，查看器可以改为自己的字段或多个规则。读取命中来源后，
检查其 `NodeSpec.variable_viewer` 和查看器规则。多个节点注册同一个查看器只算一个候选。
当前来源节点未开放查看器时返回 `type=null, editable=false` 和原因，不绕过声明走基础写入。

账号级变量、图已删除、节点类型已失效、无匹配来源、快照不存在或无法解析时，先按**登记的
类型 id** 定查看器（来源丢了也不影响账号级 / 孤儿变量），登记类型本进程不认识才回落到探测。
探测只读，不创建键、不修复计数；数据库 / 缓存连接失败仍是存储故障，不伪装成来源不存在。

选择顺序为：有效来源声明 → 登记的变量类型 → 有键族或明确规则证据的查看器。
同一阶段按 `priority` 取唯一最高值；同优先级的不同查看器冲突时，尽可能用低优先级查看器
只读展示，并给出冲突原因，修改返回 409。模块导入顺序不决定写入者。

基础 str / list / dict 的优先级为 0，合法 JSON 文本为 10，内置 ds 查看器为 100。
已命中 cache 写节点的值仍按文本展示；来源丢失时，合法 JSON 文本可按 JSON 展示。
物理 list 缺少来源和键族证据时可能是辅助键丢失的 ds-list，因此基础 list 探测只读。
不能凭 `:counts` 不存在就认定它是普通 list。

扩展节点接入示例：

```python
from tickneko.workflow.nodes import (
    JsonViewer, VariableContext, VariableRule, register_node,
)

class SettingsViewer(JsonViewer):
    type_id = "settings"   # 变量类型：登记进用户目录，同 view_type 的多种结构靠它区分
    label = "设置"
    priority = 100
    rules = (VariableRule(key_field="slot", name_pattern=r"配置-.+"),)

    @classmethod
    async def probe(cls, context: VariableContext) -> bool:
        return cls.match(context) and await super().probe(context)

@register_node("settings-write", variable_viewer=SettingsViewer)
async def write_settings(node, ctx):
    # 只描述「以什么类型、怎么写」：写入口自动做 守卫 → 写本体 → 报到，
    # 类型冲突在改坏本体之前就被拦下，不需要自己再调守卫或 remember。
    key = ctx.variable(node.config.get("scope", "workflow"), node.config["slot"])
    # 键由中枢注入 writer 的入参，节点不自己拼完整键（`writer` 收完整键字符串）
    await ctx.write_variable(
        key,
        SettingsViewer.type_id,
        lambda full: ctx.cache.set(full, "{}"),
    )
```

需要新修改参数时覆写 `add(self, /, **params)`，自行校验全部字段，非法请求抛 `ValueError`。
`self` 使用仅位置参数，保证客户端提交同名未知字段也进入参数校验，不意外变成 Python `TypeError`。

## 3. 逻辑变量与 HTTP 契约

一个逻辑变量 = **一个名字 + 一个归属**。缓存门面返回不含 Redis namespace 的逻辑键；
键里**没有「前缀」段**，同名变量由自己的类型（登记在用户目录里）与节点私有段区分：

```text
workflow:graph:{workflow_id}:{name}
workflow:acct:{owner_id}:{name}
```

**变量名即身份，一个逻辑变量只属于最先写它的那种类型。** 写变量只有一条路：
`VariableCenter.write_variable(key, type_id, writer)`（内部顺序 = 守卫 → 执行 writer →
报到）。**完整键由中枢注入 writer 的唯一参数**（`writer(full)`），节点只写「这个键怎么动」、
不自己拼键；内置 7 个写动作（cache set、ds-list 追加 / 头插 / 弹、ds-dict set / remove）与
查看器 add 统一走它，节点不再各自调守卫；接口层 `VariableService.add` 也只复用同一个
`guard`（`VariableNotEditable` 只留给只读 / 不可编辑判断）。目录里已登记别的类型时当场
报错：工作流节点抛 `VariableTypeConflict` 中断流程，接口层把同一异常转成 409 —— 两种
入口同一种判据、同一种文案，**禁止跨类型覆盖**；同类型反复写不受影响。想换类型只能先
删除变量（`drop`：`{本体}:*` 整族清 + 注销目录）再让新类型写。

变量名与归属 id 都不能包含冒号，构造 `VariableKey` 时当场拦住；辅助键（属性表 `:meta`、
节点私有段如 ds-list 的 `:counts`）是第 5 段，天然解不出来 —— 不用再靠「名字里有没有冒号」
过滤。Redis namespace 可以包含冒号，不影响本体展示。

枚举不扫变量本体键：每个归属者一个目录 map（`workflow:index:acct:{owner_id}`，hash，
field 就是完整变量键、value 是**变量类型**（写它的节点注册的 `type_id`）。写路径统一经
`VariableCenter.write_variable` 登记目录并落属性表。**类型是墓碑，不是临时状态**：弹空 /
清空只清属性与辅助键，目录登记**保留**（`sync` / `forget` 都不注销）——别的类型仍写不
进来，类型一直跟着变量身份走，直到显式删除（`drop`）。单个用户的列表读一次 `HGETALL`
就拿到全部候选，不再 `keys workflow:*` 全库扫描。管理员全量视图只扫「目录键」这一层
（每用户一个 hash，数量远小于变量本体），逐个 `HGETALL`。图级键里只有图 id，「这张图
属于谁」由工作流层把 `owner_id` 交给中枢，所以**图被删后的孤儿变量仍留在原主人的目录
里**：管理员照常看到、可删除，普通用户只读得到自己的目录。

接口前缀默认 `/api`：

| 方法 / 路径 | 作用 |
|---|---|
| `GET /api/variables` | 原有 `owner_id / scope / query / limit / offset` 查询与分页；只列**元数据**，不读本体值 |
| `GET /api/variables/types` | 可手工新建的变量类型清单（**有节点在维护**、且能直接编辑的那些） |
| `POST /api/variables` | 新建一个逻辑变量：只登记类型，本体先空着 |
| `GET /api/variables/value` | 查看一个逻辑变量（完整字段） |
| `POST /api/variables/add` | 保存（写值），整份 JSON 对象交给查看器 |
| `DELETE /api/variables` | 删除一个逻辑变量（本体与键族辅助键一并清掉，不可恢复） |

**新建**（`POST /variables`，多一个 `type_id`）给变量补上「从无到有」这一步，可建的类型只有
一份名单（`GET /variables/types` 与创建接口共用同一份判据），两条缺一不可：

* **有节点在维护**（`node_variable_viewers()`）：写变量的是节点，没人写的类型是空壳；
* 查看器允许改写（`probe_editable`）：建完得能直接编辑。

于是现行的可建类型就是三类节点的三种：`cache`（缓存）/ `ds-dict`（键值对）/ `ds-list`
（列表·计数）。基础类型 `str / json / dict` 没有任何节点声明（`viewers.py` 里只作基类与兜底
探测），通用 `list` 缺来源时不敢猜结构、只读 —— 它们都不在名单里，硬传 `type_id` 会被
409「不支持手工新建」挡下（有节点注册了同名查看器后，类型自己就会出现在界面上，不用改代码）。
顺手提一句：基础类型若真建出来还会**占住变量名** —— 同名节点写入会撞类型守卫（409）。
**变量名即身份**：这个名字已经有本体、已经登记过类型、或已被图里的节点声明（来源规则命中）
一律 409，不覆盖也不改名；没注册的 `type_id` 是 422；图级还给不出真实归属（图不存在）时 404。
登记走中枢的 `remember`（目录 + 属性表），**本体不写**：新建出来的是空变量 —— 本体不占存储键，
但登记在，列表照常列出、`/value` 按登记类型返回空值（不 404），随后用 `/add` 照常写值。
与「类型墓碑」是同一个状态：登记跟着变量身份走，要换类型先删除。

这些接口都通过 query 定位（新建多一个 `type_id`）：图级传
`scope=graph&workflow_id=...&key=...`；账号级传 `scope=account&owner_id=...&key=...`，
省略账号归属时取当前用户。
`key` 必填，就是变量名。图归属从工作流存储查，调用方不能指定或伪造。管理员可操作
所有归属与已删图的孤儿变量，普通用户只能操作自己的。

新建与删除 / 修改同一权限口径（没登录 401、普通用户碰别人的 403、图不存在 404）。
删除按
`{本体}:*` 收掉这一个变量自己的整族键（本体 + 属性表 + 节点私有段）并**注销目录登记**——
这是唯一让变量类型消失的入口（弹空 / 清空只留墓碑），不残留内部数据；不影响其它变量，
图 / 节点下次运行会重新写入同名变量。

沿用 `ApiResponse` 外壳，详情接口业务数据示例：

```json
{
  "scope": "graph",
  "owner_id": "u-admin",
  "workflow_id": "some-graph",
  "key": "队列",
  "type": "list",
  "type_label": "列表·计数",
  "data": ["a", "a", "b"],
  "length": 3,
  "editable": true,
  "reason": "",
  "ttl": null
}
```

内容都在 `data`：str 是文本本身，json / list / dict 是解析后的对象。`length` 来自 list
本体；其它类型为 null。`ttl=null` 表示无剩余过期秒数，已有本体的编辑保留其 TTL。

列表接口 `GET /variables` 只下发元数据：条目不含 `data` / `length`（不读本体值），
保留 `type / type_label / editable / reason / ttl` 等；看内容走 `/value`。
`type` / `type_label` 优先取目录里登记的类型，不用为了列一张表去 probe 本体。

| 修改请求 | 语义 |
|---|---|
| `{"value": ...}` | str / json 覆盖；JSON 保留 false、0、null 等类型 |
| `{"item": ...}` | list 新增一个元素，ds-list 联动维护频次 |
| `{"items": [...]}` | list 完整覆盖，保留顺序和重复项 |
| `{"field": "name", "value": ...}` | dict 新增 / 修改一个字段 |
| `{"fields": {...}}` | dict 完整覆盖，删除未提交的旧字段 |

`items=[] / fields={}` 是合法清空。空字符串、0、false、null 都按字段存在性判断，
具体是否允许由查看器决定。内置 cache / ds 节点继续使用文本编码：null → 空串，标量 →
Python `str`（例如 false → `"False"`），拒绝嵌套结构；普通 ListViewer / DictViewer 要求文本值。
前端不会替其它查看器把所有元素转成字符串，非文本元素用 JSON 编辑。

缺参、互斥参数、未知参数、错误类型及非法值均在查看器校验，路由将 `ValueError` 转为统一
422 响应，参数无效时不写入。请求不是 JSON 对象也返回 422。未开放编辑 / 匹配冲突返回 409；
没有本体且无法找到查看器返回 404，不探测性创建键。存储故障沿用 500 错误封装。

## 4. ds-list 键族与旧数据

一份 ds-list 有两个物理键，另加中枢替它维护的属性表：

```text
<key>          list 本体，内容与长度的唯一依据
<key>:counts   hash，编码后的文本元素 → 出现次数（节点私有段，段名由本节点自己定）
<key>:meta     hash，中枢的属性表（如 read_only），保留段名，节点不许占用
```

`["a", "a", "b"]` 的 counts 为 `a=2,b=1`。覆盖为 `["b", "b"]` 后只剩 `b=2`；
追加 / 头插加对应元素的次数，弹出后减次数，归零就删除字段。最后一个字段删除后 Redis
自动删除空 hash，`exists(<key>:counts)==false` 是正常状态。空字符串也是真实元素，不等于弹空。
`length` 始终读 LLEN，`contains` 正常情况下用 counts 的 HEXISTS。

查看 / probe 不读辅助数据来代替本体，也不修复辅助键。非空本体而 counts 缺失时，已确认的
DsListViewer 新增会先按本体重建全部频次，运行时 push / pop / contains 同样按需恢复。
完整覆盖先完成所有参数校验与元素编码，再覆盖本体并重建 counts；清空或弹空清理辅助数据。

旧版本的 `:meta={count:总数}` 和 `:idx={元素:次数}` 不做启动时批量迁移：
旧 `:idx` 可以作为键族探测线索，读操作继续读本体；首次修改或运行时 contains 从本体重建
新的 counts，再删除旧 idx。旧索引的数值不被当成正确计数依据。`count` 不再是保留字段，
新列表可以存一个文本为 `count` 的普通元素。旧 / 新辅助键均不作为独立变量暴露
（枚举只认目录里登记的**本体键**，第 5 段的辅助键天然不是候选）。

空集合不占存储键，清空 / 弹空后本体会从列表消失，但**目录登记保留**（类型墓碑）：别的类型
仍写不进来，同类型可以继续新增、重新创建键族。已确认的查看器实例或仍有来源声明的图级变量
可以继续新增；账号级 / 孤儿变量也一样 —— 登记类型还在，重新查询仍按登记类型返回空值，
不会 404。要真正注销类型只能删除变量（`drop`）。

本体与辅助键更新 **不保证跨键原子性**，并发时允许短暂不同步。中途缓存错误会向上抛出，
接口不会返回保存成功，也不宣称回滚；前端保留草稿并允许重新读取本体。正常整体覆盖成功后
频次必须对应新本体。

## 5. 前端与验证

编辑器支持文本和 JSON 保存。list / dict 的表单视图是表格：序号 + 值（dict 另有键）+ 行内图标操作
（复制到剪贴板 / 删除，dict 另有修改）；dict 行默认只读展示，点「修改」才变成输入框、点「完成」退出。
保存提交完整 `items / fields`，新增直接调用 add。已有编辑草稿未保存时先保存再新增，
避免新增后的刷新覆盖未提交修改。请求期间禁用重复提交；失败保留草稿并展示服务端 422 文案。
保存成功后**停在当前视图**（表单 / JSON 不跳转），重新调用 view 刷新真实值和长度，随后刷新列表。
只读变量只有查看入口。

列表页头部的「新增变量」弹窗建的是**空变量**：填名字、选类型（下拉由 `GET /variables/types` 下发，
前端不抄一份），作用域选账号级（归自己）或图级（再选一张图，图来自工作流列表）。值不在这里填 ——
建好后列表里点「编辑」写；弹窗里的失败（同名 409、类型不可建 409、没登录 401）原样显示服务端文案并
保留表单现场。

回归测试在 `tests/test_variable_viewers.py`、`tests/test_variables.py`、`tests/test_ds_nodes.py`：
覆盖注册兼容与去重（含 `type_id` 唯一）、来源规则、账号级 / 已删图 / 失效节点探测、
登记类型优先、规则冲突、辅助键缺失、逻辑枚举与分页（含目录登记与类型展示）、重复 / 空元素计数、
旧 idx 按需重建、完整覆盖、清空、删除（含键族清理、权限、孤儿变量、404）、
新建（类型清单、登记类型、空值不 404、同名 / 只读类型 / 缺图、权限）、权限、422、
**类型墓碑（弹空 / 清空 ≠ 删除，drop 才注销）**、**read_only 只在首次登记时落定**及部分
存储失败。
Redis 集成用例使用含冒号的独立 namespace，验证真实 HDEL 删空行为；本机无 Redis 时跳过，
CI 的 Ubuntu Redis 服务会执行。

```powershell
venv\Scripts\python.exe -m pytest -q -rs -n 4
cd frontend
npx tsc --noEmit
npm run build
node --test tests/*.test.mjs   # 本命令需要支持 TS strip 的 Node 版本（本机 Node 24）
```
