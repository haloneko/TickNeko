"""
变量查看接口的响应体。
列表（VariableSummary）与详情（VariableData）各管各的：列表只列元数据，
详情才带本体内容，两个模型互不依赖。
"""
from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict, Field

from tickneko.workflow.nodes.variable_viewer import VariableViewType

from ...services.variables import VariableSnapshot


class VariableData(BaseModel):
    """一个工作流变量的**完整内容**（详情 / 写接口返回）。"""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)

    #: 作用域：``graph`` = 图级（只有这张图看得见）；``account`` = 账号级（同账号的工作流共享）
    scope: str = Field(description="作用域：graph / account")
    #: 归属者 id：账号级 = 账号 id；图级 = 那张图的 owner；空串 = 查不到归属（图已被删）
    owner_id: str = Field(default="", description="归属 id")
    #: 所属工作流 id；账号级变量不属于某一张图，是空串
    workflow_id: str = Field(default="", description="所属工作流 id（账号级为空串）")
    #: 所属工作流的名字；图级变量才有，查不到（图已被删）是空串
    workflow_name: str = Field(default="", description="所属工作流名（图级；查不到为空串）")
    #: 变量名（缓存键前缀之后的那一段）
    key: str = Field(description="变量名")
    type: VariableViewType | None = Field(default=None, description="查看器展示类型；null = 不支持查看")
    #: 查看器注册时自带的中文名：同一个 type 下不同节点的结构靠它区分（如「列表」与「列表·计数」）
    type_label: str = Field(default="", description="查看器注册的类型名；空串 = 未注册")
    #: 查看器返回的结构化展示数据：str 是文本本身，json / list / dict 是解析后的对象
    data: Any = Field(default=None, description="查看器返回的结构化展示数据")
    length: int | None = Field(default=None, description="list 本体长度")
    editable: bool = Field(default=False, description="是否允许修改")
    reason: str = Field(default="", description="不能查看或修改的原因")
    #: 剩余存活秒数；``None`` = 永不过期
    ttl: float | None = Field(default=None, description="剩余秒数；null = 永不过期")

    @classmethod
    def from_snapshot(cls, snapshot: VariableSnapshot) -> VariableData:
        context, view = snapshot.context, snapshot.view
        return cls(
            scope=context.scope, owner_id=context.owner_id, workflow_id=context.workflow_id,
            workflow_name=snapshot.workflow_name,
            key=context.key, type=view.type, type_label=view.label,
            data=view.data, length=view.length,
            editable=view.editable, reason=view.reason, ttl=snapshot.ttl,
        )


class VariableSummary(BaseModel):
    """列表页的一行**元数据**：不读本体值，所以 data / length 不给。

    内容看详情接口 ``/value``（返回 VariableData）。与 VariableData 完全分开定义，
    列表缺什么补什么、没用的不放。
    """

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)

    scope: str = Field(description="作用域：graph / account")
    owner_id: str = Field(default="", description="归属 id")
    workflow_id: str = Field(default="", description="所属工作流 id（账号级为空串）")
    workflow_name: str = Field(default="", description="所属工作流名（图级；查不到为空串）")
    key: str = Field(description="变量名")
    type: VariableViewType | None = Field(default=None, description="查看器展示类型；null = 不支持查看")
    type_label: str = Field(default="", description="查看器注册的类型名；空串 = 未注册")
    editable: bool = Field(default=False, description="是否允许修改")
    reason: str = Field(default="", description="不能查看或修改的原因")
    ttl: float | None = Field(default=None, description="剩余秒数；null = 永不过期")

    @classmethod
    def from_snapshot(cls, snapshot: VariableSnapshot) -> VariableSummary:
        context, view = snapshot.context, snapshot.view
        return cls(
            scope=context.scope, owner_id=context.owner_id, workflow_id=context.workflow_id,
            workflow_name=snapshot.workflow_name,
            key=context.key, type=view.type, type_label=view.label,
            editable=view.editable, reason=view.reason, ttl=snapshot.ttl,
        )


class VariablePage(BaseModel):
    """变量列表的**一页**：本页条目 + 命中总数（前端据此算总页数、做页码跳转）。"""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)

    #: 本页的变量元数据（按作用域 / 归属 / 所属图 / 变量名排序，同一条件两次查顺序一致）
    items: list[VariableSummary] = Field(description="本页变量")
    #: 命中条件的**总条数**（不受本页 ``limit`` / ``offset`` 限制）
    total: int = Field(description="命中总条数")
