"""变量发现、来源反查与只读探测；不解释存储值，见 docs/variables/variables.md。

键怎么拼、用户目录（类型表）怎么读、属性表怎么落 —— 全归变量中枢
（:class:`~tickneko.variables.center.VariableCenter`），这一层只管**业务口径**：
枚举、反查来源、挑查看器、判能不能改。

**类型是节点注册的**（``VariableViewer.type_id``），变量写进缓存时就登记进它所属用户的
目录里（中枢的 ``remember``）。所以这里定类型有两条路：先按图反查来源节点（拿得到规则与
写入语义），反查不到就用目录里登记的类型 —— 账号级变量、图被删的孤儿变量、来源已丢失的
变量，都能照登记的类型正常查看与改写，不用再靠 probe 猜。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Any, Protocol

from tickneko.core.cache.interfaces import CacheBackend
from tickneko.variables import (
    DIRECTORY_PATTERN,
    VariableCenter,
    VariableContext,
    VariableRule,
    VariableView,
    VariableViewer,
    get_variable_viewer,
    parse_variable_key,
    registered_variable_viewers,
)
from tickneko.workflow.models import (
    WorkflowDefinitionRecord,
    WorkflowNode,
    WorkflowVersionRecord,
)
from tickneko.workflow.nodes.registry import get_spec


class VariableStore(Protocol):
    """只依赖读取定义与版本；不把工作流存储实现或 HTTP 引入分派。"""

    async def get(self, workflow_id: str) -> WorkflowDefinitionRecord | None: ...

    async def get_version(
        self, workflow_id: str, version: int
    ) -> WorkflowVersionRecord | None: ...


class VariableNotFound(LookupError):
    """本体不存在且没有有效的来源声明。"""


class VariableNotEditable(RuntimeError):
    """来源未开放查看器、规则冲突或无法安全确定写入语义。"""


@dataclass(frozen=True)
class VariableSnapshot:
    context: VariableContext
    view: VariableView
    ttl: float | None
    #: 所属工作流的名字（图级才有；账号级 / 图被删是空串）：只给响应里人看的，不参与键规则
    workflow_name: str = ""


@dataclass(frozen=True)
class _Resolution:
    viewer: VariableViewer | None
    reason: str = ""


class VariableService:
    def __init__(
        self,
        cache: CacheBackend,
        store: VariableStore,
        center: VariableCenter | None = None,
    ) -> None:
        self.cache = cache
        self.store = store
        #: 变量中枢：正常与运行时共用同一个（见 ``workflow.runtime.variable_center``）
        self.center: VariableCenter = center if center is not None else VariableCenter(cache)
        self._records: dict[str, WorkflowDefinitionRecord | None] = {}
        self._nodes: dict[str, list[WorkflowNode] | None] = {}

    async def _record(self, workflow_id: str) -> WorkflowDefinitionRecord | None:
        if workflow_id not in self._records:
            self._records[workflow_id] = await self.store.get(workflow_id)
        return self._records[workflow_id]

    async def context(
        self, *, scope: str, key: str, owner_id: str = "", workflow_id: str = ""
    ) -> VariableContext:
        """把人给的（作用域 / 名字 / 归属）绑成一个经过校验的变量身份。

        :raises ValueError: 作用域不是 graph/account；名字为空或带冒号；归属与作用域不匹配。
        """
        if scope not in ("graph", "account"):
            raise ValueError("作用域要 graph/account 之一")
        if not key or ":" in key:
            raise ValueError("变量名必须非空且不能包含冒号")
        if scope == "account":
            if not owner_id or ":" in owner_id or workflow_id:
                raise ValueError("账号级变量需要合法 owner_id，不能指定 workflow_id")
            return self._bind(scope, key, owner_id=owner_id)
        if not workflow_id or ":" in workflow_id:
            raise ValueError("图级变量需要合法 workflow_id")
        record = await self._record(workflow_id)
        return self._bind(
            scope,
            key,
            owner_id=record.owner_id if record else "",
            workflow_id=workflow_id,
        )

    def _bind(
        self,
        scope: str,
        key: str,
        *,
        owner_id: str = "",
        workflow_id: str = "",
        type_id: str = "",
    ) -> VariableContext:
        """拼上下文（键由中枢校验与拼装）；``type_id`` 是用户目录里登记的类型，没有就是空串。"""
        variable = self.center.key(
            scope, key, owner_id=owner_id, workflow_id=workflow_id
        )
        return VariableContext(
            self.cache,
            self.center,
            variable.scope,
            owner_id=owner_id,
            workflow_id=workflow_id,
            name=key,
            type_id=type_id,
        )

    async def discover(
        self, *, scope: str | None, keyword: str, owner: str | None
    ) -> list[VariableContext]:
        """枚举候选：只读**用户目录**（field = 完整变量键，value = 变量类型），不扫变量本体。

        * ``owner`` 给了：HGETALL 那一个人的目录 —— 枚举一次 O(1)，不碰别的键；
        * ``owner`` 为空（管理员全量视图）：只扫「目录键」这一层（``workflow:index:acct:*``，
          每用户一个 hash，数量远小于变量本体），逐个 HGETALL；不扫变量本体键。

        目录里的类型一并带进上下文：枚举时就知道每条变量是哪种（节点注册的），
        不用为了拿类型去逐条反查图。
        """
        candidates: dict[str, tuple[str, str]] = {}
        if owner is None:
            for directory in await self.cache.keys(DIRECTORY_PATTERN):
                owner_id = directory.rsplit(":", 1)[-1]
                for raw, type_id in (await self.cache.hash_get_all(directory)).items():
                    candidates[raw] = (owner_id, type_id)
        else:
            directory = await self.center.directory(owner)
            for raw, type_id in directory.items():
                candidates[raw] = (owner, type_id)
        rows: dict[str, VariableContext] = {}
        for raw, (directory_owner, type_id) in candidates.items():
            variable = parse_variable_key(raw)
            if variable is None:
                continue
            if scope is not None and scope != variable.scope:
                continue
            if keyword and keyword not in variable.name:
                continue
            # 目录归属就是归属者：图级变量登记在**图的主人**名下，不用再查定义表。
            rows[raw] = self._bind(
                variable.scope,
                variable.name,
                owner_id=directory_owner,
                workflow_id=variable.workflow_id,
                type_id=type_id,
            )
        return sorted(
            rows.values(),
            key=lambda row: (row.scope, row.owner_id, row.workflow_id, row.name),
        )

    async def _source_nodes(
        self, context: VariableContext
    ) -> list[WorkflowNode] | None:
        if context.scope == "account":
            return None
        ident = context.workflow_id
        if ident in self._nodes:
            return self._nodes[ident]
        record = await self._record(ident)
        nodes: list[WorkflowNode] | None = None
        if record is not None:
            # 运行时使用已发布快照；未发布时依次检查提交版本、暂存区。
            version_number = record.published_version or record.current_version
            if version_number:
                version = await self.store.get_version(ident, version_number)
                if version is not None:
                    try:
                        nodes = version.graph().nodes
                    except ValueError:
                        pass  # 无法反查，不把不存在 / 已失效的来源变成 500。
            elif record.draft_graph_json:
                try:
                    graph = record.draft_graph()
                    if graph is not None:
                        nodes = [
                            WorkflowNode.model_validate(node.model_dump())
                            for node in graph.nodes
                        ]
                except ValueError:
                    pass
        self._nodes[ident] = nodes
        return nodes

    async def _probes(self, context: VariableContext) -> list[type[VariableViewer]]:
        return [
            viewer
            for viewer in registered_variable_viewers()
            if await viewer.probe(context)
        ]

    async def _choose(
        self,
        context: VariableContext,
        viewers: dict[type[VariableViewer], VariableContext],
        *,
        probed: bool,
    ) -> _Resolution:
        priority = max(viewer.priority for viewer in viewers)
        top = [viewer for viewer in viewers if viewer.priority == priority]
        if len(top) > 1:
            reason = "多个变量查看器的规则冲突，不能确定安全的修改方式"
            # 用唯一的低优先级探测结果只读展示；不按模块导入顺序挑写入者。
            lower = {
                viewer: context
                for viewer in await self._probes(context)
                if viewer.priority < priority
            }
            if lower:
                resolution = await self._choose(context, lower, probed=True)
                if resolution.viewer is not None:
                    resolution.viewer.editable = False
                    resolution.viewer.reason = reason
                    return _Resolution(resolution.viewer, reason)
            return _Resolution(None, reason)
        viewer_type = top[0]
        bound = viewers[viewer_type]
        if not await viewer_type.accepts(bound):
            return _Resolution(None, "变量本体与来源节点声明的存储类型不一致")
        editable = not probed or viewer_type.probe_editable
        reason = (
            "来源已丢失，无法确定变量结构的联动规则，只允许查看" if not editable else ""
        )
        return _Resolution(viewer_type(bound, editable=editable, reason=reason), reason)

    def _registered_viewer(self, context: VariableContext) -> type[VariableViewer] | None:
        """用户目录里登记的那种类型对应的查看器；没登记 / 本进程不认识就是 ``None``。"""
        return get_variable_viewer(context.type_id) if context.type_id else None

    async def _from_registered(
        self, context: VariableContext, viewer_type: type[VariableViewer]
    ) -> _Resolution:
        """按**登记的类型**定查看器：不依赖图，账号级 / 来源已丢失的变量走这条。"""
        bound = replace(context, node=None)
        if not await viewer_type.accepts(bound):
            return _Resolution(None, "变量本体与登记的类型不一致")
        editable = viewer_type.probe_editable
        reason = "" if editable else "登记的类型不支持直接改写，只允许查看"
        return _Resolution(viewer_type(bound, editable=editable, reason=reason), reason)

    async def resolve(self, context: VariableContext) -> _Resolution:
        nodes = await self._source_nodes(context)
        if nodes is not None:
            candidates: dict[type[VariableViewer], VariableContext] = {}
            for node in sorted(nodes, key=lambda node: node.id):
                spec = get_spec(node.type)
                if spec is None:
                    continue  # 扩展模块已卸载 / 节点类型失效：走登记类型或真实 probe。
                bound = replace(context, node=node)
                if spec.variable_viewer is None:
                    if VariableRule().matches(bound):
                        return _Resolution(None, "来源节点未开放变量查看器")
                elif spec.variable_viewer.match(bound):
                    if spec.variable_viewer not in candidates:
                        candidates[spec.variable_viewer] = bound
            if candidates:
                return await self._choose(context, candidates, probed=False)
        registered = self._registered_viewer(context)
        if registered is not None:
            return await self._from_registered(context, registered)
        probes = {viewer: context for viewer in await self._probes(context)}
        if probes:
            return await self._choose(context, probes, probed=True)
        return _Resolution(None, "没有能处理该变量的查看器")

    async def _attributes_aware(
        self, context: VariableContext, view: VariableView
    ) -> VariableView:
        """把属性表（``{本体}:meta``）合进视图，并据此收紧可改性。

        ``read_only`` 为真 = 这种变量生来不给手改（由写它的节点声明）：哪怕来源规则说能改，
        也一律按只读返回 —— 属性表是**落过盘的事实**，比运行时推断更硬。
        """
        attributes = await self.center.attributes(context.variable_key)
        if not attributes:
            return view
        if await self.center.is_read_only(context.variable_key) and view.editable:
            return replace(
                view,
                editable=False,
                reason="变量被标记为只读（read_only）",
                attributes=attributes,
            )
        return replace(view, attributes=attributes)

    async def _snapshot(
        self, context: VariableContext, view: VariableView
    ) -> VariableSnapshot:
        ttl = await self.cache.ttl(context.full_key)
        # 图名随快照一起给出：图级才有，图被删了就只剩 id（记录已按图缓存，不重复查存储）
        name = ""
        if context.scope == "graph" and context.workflow_id:
            record = await self._record(context.workflow_id)
            name = record.name if record else ""
        return VariableSnapshot(
            context,
            view,
            ttl if ttl is not None and math.isfinite(ttl) else None,
            workflow_name=name,
        )

    async def view(self, context: VariableContext) -> VariableSnapshot:
        resolution = await self.resolve(context)
        if resolution.viewer is None:
            if not await self.cache.exists(context.full_key):
                raise VariableNotFound("变量不存在")
            view = VariableView(None, reason=resolution.reason)
        else:
            view = await resolution.viewer.view()
        return await self._snapshot(context, await self._attributes_aware(context, view))

    async def summary(self, context: VariableContext) -> VariableSnapshot:
        """列表页的轻量元数据：只反查来源定类型，不读本体值（data / length 为空）。"""
        resolution = await self.resolve(context)
        if resolution.viewer is None:
            if not await self.cache.exists(context.full_key):
                raise VariableNotFound("变量不存在")
            view = VariableView(None, reason=resolution.reason)
        else:
            viewer = resolution.viewer
            view = VariableView(
                type=viewer.view_type,
                data=None,
                length=None,
                editable=viewer.editable,
                reason=viewer.reason,
                label=viewer.label,
            )
        return await self._snapshot(context, await self._attributes_aware(context, view))

    async def page(
        self,
        *,
        scope: str | None,
        keyword: str,
        owner: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[VariableSnapshot], int]:
        """变量清单：只列元数据、不读本体值（一个接口一个职责，详情走 view()）。"""
        rows = await self.discover(scope=scope, keyword=keyword, owner=owner)
        snapshots: list[VariableSnapshot] = []
        for row in rows[offset : offset + limit]:
            try:
                snapshots.append(await self.summary(row))
            except VariableNotFound:
                pass  # 枚举后过期的本体不把整页变成 404；总数是本次发现时的快照。
        return snapshots, len(rows)

    async def add(
        self, context: VariableContext, params: dict[str, Any]
    ) -> VariableSnapshot:
        resolution = await self.resolve(context)
        viewer = resolution.viewer
        if viewer is None or not viewer.editable:
            if viewer is None and not await self.cache.exists(context.full_key):
                raise VariableNotFound("变量不存在")
            raise VariableNotEditable(resolution.reason or "该变量只允许查看")
        if await self.center.is_read_only(context.variable_key):
            raise VariableNotEditable("变量被标记为只读（read_only）")
        # 类型守卫：与运行时同一套判据、同一种异常（VariableTypeConflict -> 409），不再自写
        # 一套。目录里的 type_id 是**落过盘的事实**，以它为准 —— 调用方带来的 context.type_id
        # 可能没查目录；要换类型先删除变量。空登记（老数据）视为未登记。
        await self.center.guard(
            context.variable_key, viewer.type_id, owner_id=context.owner_id
        )
        await viewer.add(**params)
        return await self._snapshot(
            context, await self._attributes_aware(context, await viewer.view())
        )

    async def delete(self, context: VariableContext) -> None:
        """删除一个逻辑变量；本体不存在抛 ``VariableNotFound``。

        键族（本体 / 属性表 / 节点私有段）交给中枢整族清掉 —— 节点私有段叫什么由节点自己定，
        这一层不该也不必知道；所属用户目录里的登记字段与属性表一并注销。
        """
        if not await self.cache.exists(context.full_key):
            raise VariableNotFound("变量不存在")
        await self.center.drop(context.variable_key, owner_id=context.owner_id)


__all__ = [
    "VariableNotFound",
    "VariableNotEditable",
    "VariableService",
    "VariableSnapshot",
    "VariableStore",
]
