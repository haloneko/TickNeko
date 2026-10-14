"""变量键布局的**唯一实现处**：一个逻辑变量在缓存里占哪些物理键、怎么拼、怎么解。

一个逻辑变量 = 一个**名字** + 一个**归属**（图级 = 哪张工作流；账号级 = 哪个账号）。
缓存里它拆成三类键（见 :class:`VariableKey`）::

    workflow:graph:{图 id}:{变量名}               本体（string / list / hash，看变量类型）
    workflow:graph:{图 id}:{变量名}:meta          属性表（hash：read_only 这类通用属性）
    workflow:graph:{图 id}:{变量名}:{节点自定义}   节点自己的结构（如列表的频次索引）

    workflow:acct:{账号 id}:{变量名}              账号级同理，只是归属段换成账号 id
    workflow:acct:{账号 id}:{变量名}:meta
    workflow:acct:{账号 id}:{变量名}:{节点自定义}

**键里没有「前缀」** —— 变量的身份就是「归属 + 名字」，「同名不同节点」由变量自己的
**类型**（登记在用户目录里，见 :func:`directory_key`）与**节点私有段**区分，不再靠名字前
再挂一段命名空间。

**变量名 / 归属 id 都不允许带冒号**：冒号是键的分段分隔符，带进去会把键从中间劈开
（``a:b`` 会被解成两个变量），当场拦住比事后猜好。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: 变量的作用域：``graph`` = 图级（只有这张图看得见）；``account`` = 账号级（同账号共享）
VariableScope = Literal["graph", "account"]

#: 键的根段：所有变量键都挂在它下面
ROOT: str = "workflow"

#: 每个用户一张**用户目录**（hash）：field = 完整变量键、value = **变量类型**
#: （由节点注册，见 ``VariableViewer.type_id``）。枚举变量只读这张表，不扫变量本体。
DIRECTORY_PREFIX: str = f"{ROOT}:index:acct:"

#: 扫全部用户目录用的模式（管理员全量视图只看这一层，数量远小于变量本体）
DIRECTORY_PATTERN: str = f"{DIRECTORY_PREFIX}*"

#: 属性表的段名：``{本体}:meta``。**保留段**，节点私有结构不许用它
ATTRIBUTES_SEGMENT: str = "meta"

#: 属性表里的「只读」字段：由写它的节点声明，改动前先看它（见 ``VariableCenter.is_read_only``）
VARIABLE_ATTRIBUTES_READ_ONLY: str = "read_only"

#: 作用域 -> 键里的段名（键里用短名）：``account`` 落成 ``acct``
_SCOPE_TO_SEGMENT: dict[str, str] = {"graph": "graph", "account": "acct"}

#: 键里的段名 -> 作用域
_SEGMENT_TO_SCOPE: dict[str, VariableScope] = {"graph": "graph", "acct": "account"}

#: 图级变量「不知道是哪张图」时的归属占位：离线跑 / 测试直接构造上下文
NO_IDENT: str = "local"


def directory_key(owner_id: str) -> str:
    """某个归属者的**用户目录**：field = 完整变量键，value = 变量类型。"""
    return f"{DIRECTORY_PREFIX}{owner_id}"


def _check_segment(value: str, what: str) -> str:
    if not value or ":" in value:
        raise ValueError(f"{what}不能为空、也不能包含冒号：{value!r}")
    return value


@dataclass(frozen=True)
class VariableKey:
    """一个逻辑变量的身份：作用域 + 归属 id + 名字；派生它所有的物理键。

    :param scope: ``graph`` / ``account``；
    :param ident: 归属 id —— 图级是 ``workflow_id``，账号级是 ``owner_id``；
    :param name: 变量名（节点 config 里的 ``key``）。

    :raises ValueError: 归属 id 或名字为空 / 带冒号（构造时当场拦）。
    """

    scope: VariableScope
    ident: str
    name: str

    def __post_init__(self) -> None:
        if self.scope not in _SCOPE_TO_SEGMENT:
            raise ValueError(f"作用域要 graph / account 之一：{self.scope!r}")
        _check_segment(self.ident, "归属 id")
        _check_segment(self.name, "变量名")

    @property
    def segment(self) -> str:
        """键里的作用域段：``graph`` / ``acct``。"""
        return _SCOPE_TO_SEGMENT[self.scope]

    @property
    def full(self) -> str:
        """本体键：``workflow:{图 id 或账号 id}:{变量名}``。"""
        return f"{ROOT}:{self.segment}:{self.ident}:{self.name}"

    @property
    def attributes(self) -> str:
        """属性表键：``{本体}:meta``（hash）。"""
        return f"{self.full}:{ATTRIBUTES_SEGMENT}"

    def node(self, segment: str) -> str:
        """**节点私有结构**的键：``{本体}:{段名}``，段名由节点自己定。

        :raises ValueError: 段名为空 / 带冒号 / 占用保留段（``meta``）。
        """
        _check_segment(segment, "节点结构段名")
        if segment == ATTRIBUTES_SEGMENT:
            raise ValueError(f"节点结构段名不能占用保留段 {ATTRIBUTES_SEGMENT!r}（属性表）")
        return f"{self.full}:{segment}"

    @property
    def owner_id(self) -> str:
        """键里能直接看出来的归属：账号级就是账号自己；图级是空串。

        图级变量的主人不在这层（键里只有图 id），得由工作流层把 ``owner_id`` 带进中枢
        （见 :meth:`~tickneko.variables.center.VariableCenter.remember`）。
        """
        return self.ident if self.scope == "account" else ""

    @property
    def workflow_id(self) -> str:
        """这个变量挂在哪张图上（账号级是空串）。"""
        return self.ident if self.scope == "graph" else ""


def parse_variable_key(raw: str) -> VariableKey | None:
    """解一个**本体键**（缓存门面已剥去 namespace）；不是本体键返回 ``None``。

    形状固定 4 段 ``workflow:{graph|acct}:{归属 id}:{变量名}``。辅助键（``:meta``、
    节点私有段）是第 5 段，天然解不出来 —— 不用再靠「名字里有没有冒号」过滤。
    """
    parts = raw.split(":")
    if len(parts) != 4 or parts[0] != ROOT or parts[1] not in _SEGMENT_TO_SCOPE:
        return None
    ident, name = parts[2], parts[3]
    if not ident or not name:
        return None
    return VariableKey(_SEGMENT_TO_SCOPE[parts[1]], ident, name)


def graph_key(workflow_id: str, name: str) -> VariableKey:
    """图级变量的键；``workflow_id`` 缺省（离线跑）用 :data:`NO_IDENT`。"""
    return VariableKey("graph", workflow_id or NO_IDENT, name)


def account_key(owner_id: str, name: str) -> VariableKey:
    """账号级变量的键。

    :raises ValueError: 不知道归属（``owner_id`` 为空）—— 不知道是谁的变量不能瞎写。
    """
    if not owner_id:
        raise ValueError("账号级变量需要归属（owner_id 为空）：离线跑请改用图级作用域")
    return VariableKey("account", owner_id, name)
