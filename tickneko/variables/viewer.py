"""变量查看契约：**一个变量由哪个节点拥有、怎么读、能不能改**；口径见 docs/variables/variables.md。

这套契约是「变量中枢」对外的另一半：:mod:`.keys` 只管键怎么拼，这里管**类型**——
变量是文本 / JSON / 列表 / 字典（``view_type``，界面按它挑渲染器），以及它是**哪个节点
拥有的**（``type_id``，登记进用户目录，见 :func:`~tickneko.variables.keys.directory_key`）。

节点注册时带上自己的查看器（``register_node(..., variable_viewer=DsListViewer)``），
**类型是节点自己注册的**：``type_id`` 唯一标识一种变量的语义，「列表」与「列表·计数」
靠它区分，不靠名字猜。
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar, Literal, Protocol

from tickneko.core.cache.interfaces import CacheBackend

from .keys import VariableKey, VariableScope

if TYPE_CHECKING:  # 只给类型标注用：中枢反向依赖本模块，别在运行期绕成环
    from .center import VariableCenter


#: 界面上的展示类型：前端按它挑渲染器（文本 / JSON / 列表 / 字典）
VariableViewType = Literal["json", "list", "dict", "str"]

__all__ = [
    "VariableContext",
    "VariableRule",
    "VariableScope",
    "VariableView",
    "VariableViewType",
    "VariableViewer",
    "get_variable_viewer",
    "register_variable_viewer",
    "registered_variable_viewers",
    "text_parameter",
]


class NodeLike(Protocol):
    """变量来源节点的**最小形状**：只读它的 ``config`` 反推归属（``WorkflowNode`` 天然满足）。

    放在协议里而不是 import ``WorkflowNode``：中枢这一层只跟缓存打交道，不该认识工作流模型。
    """

    config: Mapping[str, Any]


@dataclass(frozen=True)
class VariableContext:
    """经鉴权绑定的变量身份：作用域 + 归属 + 名字，外加读它要用的缓存与中枢。

    :param cache: 缓存门面（本体 / 属性表都从它读写）；
    :param center: 变量中枢（登记用户目录、属性表都走它）；
    :param scope: ``graph`` = 图级；``account`` = 账号级；
    :param owner_id: **这个变量属于谁** —— 账号级就是它自己；图级是那张图的主人（查不到空串）；
    :param workflow_id: 图级变量挂在哪张图上；账号级是空串；
    :param name: 变量名；
    :param node: 来源节点（反查出来的，可能没有）：规则要靠它的 ``config`` 判定；
    :param type_id: **用户目录里登记的变量类型**（节点注册的，见 ``VariableViewer.type_id``）；
        没登记（老数据 / 手工塞的键）就是空串，这时才回落到 probe 猜。
    """

    cache: CacheBackend
    center: VariableCenter
    scope: VariableScope
    owner_id: str
    workflow_id: str
    name: str
    node: NodeLike | None = None
    type_id: str = ""

    @property
    def variable_key(self) -> VariableKey:
        """它在缓存里的身份（派生全部分段键）。"""
        ident = self.owner_id if self.scope == "account" else self.workflow_id
        return VariableKey(self.scope, ident, self.name)

    @property
    def full_key(self) -> str:
        """本体键（查看器的读写都落在它上）。"""
        return self.variable_key.full


@dataclass(frozen=True)
class VariableRule:
    """变量归属规则：节点配置字段，或能在来源丢失后识别的逻辑名称模式。

    :param key_field: 节点 config 里放变量名的字段（默认 ``key``）；
    :param scope_field: 放作用域的字段（默认 ``scope``）；
    :param action_field: 放动作的字段（默认 ``action``，如 cache 节点的 get / set）；
    :param actions: 只认这些动作（空 = 都认）；
    :param name_pattern: 变量名模式（来源丢了也认）；
    :param scopes: 认哪些作用域。
    """

    key_field: str = "key"
    scope_field: str = "scope"
    action_field: str = "action"
    actions: tuple[str, ...] = ()
    name_pattern: str = ""
    scopes: tuple[VariableScope, ...] = ("graph", "account")

    def matches(self, context: VariableContext) -> bool:
        if context.scope not in self.scopes:
            return False
        if self.name_pattern and re.fullmatch(self.name_pattern, context.name) is None:
            return False
        node = context.node
        if node is None:
            return bool(self.name_pattern)
        scope = str(node.config.get(self.scope_field, "")).strip() or "workflow"
        expected = "account" if context.scope == "account" else "workflow"
        name = str(node.config.get(self.key_field, "")).strip()
        if scope != expected or name != context.name:
            return False
        return not self.actions or node.config.get(self.action_field) in self.actions


@dataclass(frozen=True)
class VariableView:
    """展示类型与物理类型分离；``length`` 由查看器从本体读取。

    :param attributes: 属性表（``{本体}:meta``）的内容，如 ``{"read_only": "true"}``。
    """

    type: VariableViewType | None
    data: Any = None
    length: int | None = None
    editable: bool = False
    reason: str = ""
    #: 查看器自己注册的中文名（界面显示用）；没注册就空串，前端退回按 type 映射
    label: str = ""
    #: 变量自己的属性表；``read_only`` 为真时不允许改写（见 :class:`VariableViewer`）
    attributes: dict[str, str] = field(default_factory=dict)


# --------------------------------------------------------------------------- 类型注册表
#: ``type_id`` -> 查看器类：变量类型**由节点注册**，用户目录里存的就是这个 id
_VIEWERS_BY_TYPE: dict[str, type[VariableViewer]] = {}


def register_variable_viewer(viewer: type[VariableViewer]) -> None:
    """登记一种变量类型（``viewer.type_id`` 唯一）。

    :raises ValueError: 不是 :class:`VariableViewer` 子类，或 ``type_id`` 已被**别的**类占。
    """
    if not issubclass(viewer, VariableViewer):
        raise ValueError("查看器必须是 VariableViewer 子类")
    existing = _VIEWERS_BY_TYPE.get(viewer.type_id)
    if existing is not None and existing is not viewer:
        raise ValueError(
            f"变量类型 {viewer.type_id!r} 已被 {existing.__qualname__} 注册，"
            f"{viewer.__qualname__} 不能重复占用"
        )
    _VIEWERS_BY_TYPE[viewer.type_id] = viewer


def registered_variable_viewers() -> tuple[type[VariableViewer], ...]:
    """已登记的变量类型（按 ``type_id`` 排序）。"""
    return tuple(_VIEWERS_BY_TYPE[key] for key in sorted(_VIEWERS_BY_TYPE))


def get_variable_viewer(type_id: str) -> type[VariableViewer] | None:
    """按类型 id 取查看器；没注册返回 ``None``（用户目录里存了个本进程不认识的类型）。"""
    return _VIEWERS_BY_TYPE.get(type_id)


class VariableViewer:
    """子类声明规则与只读 probe，实现 view / add；同优先级冲突禁止写入。

    :cvar view_type: 界面展示类型（前端按它挑渲染器）；
    :cvar type_id: **变量类型 id** —— 节点注册的那种变量语义（用户目录里存的就是它），
        同一个 ``view_type`` 下的多种结构靠它区分（如 ``list`` 与 ``ds-list``）；
    :cvar label: 界面上显示的中文名；
    :cvar read_only: 这种变量**生来只读**（由写它的节点决定，落进 ``:meta``）。
    """

    view_type: ClassVar[VariableViewType] = "str"
    type_id: ClassVar[str] = "str"
    label: ClassVar[str] = ""
    rules: ClassVar[tuple[VariableRule, ...]] = (VariableRule(),)
    priority: ClassVar[int] = 100
    storage_types: ClassVar[tuple[str, ...]] = ()
    probe_editable: ClassVar[bool] = True
    read_only: ClassVar[bool] = False

    def __init__(
        self, context: VariableContext, *, editable: bool = True, reason: str = ""
    ) -> None:
        self.context = context
        self.editable = editable
        self.reason = reason

    @classmethod
    def match(cls, context: VariableContext) -> bool:
        return any(rule.matches(context) for rule in cls.rules)

    @classmethod
    async def probe(cls, context: VariableContext) -> bool:
        """没有来源节点时探测；不得创建、重建或修改任何键。"""
        return False

    @classmethod
    async def accepts(cls, context: VariableContext) -> bool:
        if not cls.storage_types:
            return True
        kind = await context.cache.type(context.full_key)
        return kind is None or kind in cls.storage_types

    def result(self, data: Any, *, length: int | None = None) -> VariableView:
        """本体读出来的成果；属性表由中枢在返回前合并进来（查看器只管本体）。"""
        return VariableView(
            self.view_type, data, length, self.editable, self.reason, self.label
        )

    async def view(self) -> VariableView:
        raise NotImplementedError

    async def add(self, /, **params: Any) -> None:
        raise NotImplementedError

    async def _sync_index(self) -> None:
        """``add`` 写完后同步所属用户目录：本体还在就登记（带上自己的类型）、没了留**墓碑**。

        field = 完整变量键（带作用域与归属，天然唯一），value = **本查看器的类型 id**；
        本体消失（清空列表 / 字典会让键消失）**不注销**登记 —— 类型墓碑：弹空 ≠ 删除，别的
        类型仍写不进来，只有接口删除（``VariableCenter.drop``）才真正注销。
        """
        await self.context.center.sync(
            self.context.variable_key, self.type_id, owner_id=self.context.owner_id
        )

    def validate_params(self, params: dict[str, Any], *forms: set[str]) -> None:
        """按字段存在性校验整份请求；空值不等于缺参。"""
        if not self.editable:
            raise ValueError(self.reason or "该变量只允许查看")
        keys = set(params)
        if keys in forms:
            return
        allowed = set().union(*forms)
        unknown = keys - allowed
        if unknown:
            raise ValueError(f"不支持的参数：{', '.join(sorted(unknown))}")
        choices = " 或 ".join(" + ".join(sorted(form)) for form in forms)
        raise ValueError(f"请提交 {choices}，参数不能缺少或混用")

    async def write_ttl(self) -> float | None:
        """编辑保留已有本体的 TTL；新键沿用缓存默认值。"""
        ttl = await self.context.cache.ttl(self.context.full_key)
        return 0.0 if ttl is not None and math.isinf(ttl) else ttl


def text_parameter(value: Any) -> str:
    """文本节点的编码：沿用 None → 空串、标量 → str，拒绝嵌套结构。"""
    if value is None:
        return ""
    if not isinstance(value, (str, int, float, bool)):
        raise ValueError("文本值必须是字符串、数字、布尔值或 null")  # noqa: TRY004 查看器统一以 ValueError 返回 422。
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("数字必须是有限值")
    return str(value)
