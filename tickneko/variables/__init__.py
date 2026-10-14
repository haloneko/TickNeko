"""变量中枢：**缓存的变量都从这里进出** —— 键布局、类型登记、属性表、用户目录。

分三层看这个包::

    keys.py      一个变量的物理键族（本体 / 属性表 / 节点私有结构）+ 用户目录键
    viewer.py    变量类型契约：VariableViewer + 类型注册表 + 上下文 / 规则 / 视图
    viewers.py   四种基础类型（文本 / JSON / 列表 / 字典）的显式注册
    center.py    VariableCenter：把上面几样收成一个门面，跟缓存层打交道

谁跟谁打交道：接口层只跟 :class:`VariableCenter` 和查看器契约说话；工作流这一层把中枢
注入执行上下文（``ctx.variables`` / ``ctx.variable()`` / ``ctx.write_variable()`` ——
写变量的**唯一入口**：守卫 -> 写本体 -> 报到），节点再通过上下文用它 —— 节点不自己拼键、
不自己调守卫、不自己登记目录。用户隔离由工作流这一层带进来（``owner_id``），中枢按归属者
分目录。
"""
from __future__ import annotations

from .center import VariableCenter, VariableTypeConflict
from .keys import (
    ATTRIBUTES_SEGMENT,
    DIRECTORY_PATTERN,
    NO_IDENT,
    ROOT,
    VARIABLE_ATTRIBUTES_READ_ONLY,
    VariableKey,
    VariableScope,
    account_key,
    directory_key,
    graph_key,
    parse_variable_key,
)
from .viewer import (
    VariableContext,
    VariableRule,
    VariableView,
    VariableViewer,
    VariableViewType,
    get_variable_viewer,
    register_variable_viewer,
    registered_variable_viewers,
    text_parameter,
)
from .viewers import DictViewer, JsonViewer, ListViewer, StringViewer

__all__ = [
    "ATTRIBUTES_SEGMENT",
    "DIRECTORY_PATTERN",
    "NO_IDENT",
    "ROOT",
    "VARIABLE_ATTRIBUTES_READ_ONLY",
    "DictViewer",
    "JsonViewer",
    "ListViewer",
    "StringViewer",
    "VariableCenter",
    "VariableContext",
    "VariableTypeConflict",
    "VariableKey",
    "VariableRule",
    "VariableScope",
    "VariableView",
    "VariableViewType",
    "VariableViewer",
    "account_key",
    "directory_key",
    "get_variable_viewer",
    "graph_key",
    "parse_variable_key",
    "register_variable_viewer",
    "registered_variable_viewers",
    "text_parameter",
]
