"""变量中枢：**谁想动缓存里的变量都得先经过它** —— 键怎么拼、谁拥有它、它有什么属性。

一份变量在缓存里不是一个键，是一族键（见 :mod:`.keys`）。中枢把这族键的**记账活**收在
一处，别人只跟它打交道：

* 上层（接口层 / 节点）只描述「作用域 + 归属 + 名字 + 类型」，不自己拼键；
* 中枢跟缓存层打交道（:class:`~tickneko.core.cache.interfaces.CacheBackend`）：登记用户
  目录（field = 完整变量键，value = 变量类型）、维护属性表（``{本体}:meta``）；
* **写变量只有一条路**（:meth:`write_variable` = 守卫 -> 写本体 -> 报到）：类型冲突在写
  本体**之前**就被拦下；节点 / 接口层不再各自调守卫、也不自己拼「登记」这步；
* **类型是墓碑，不是临时状态**：本体弹空 / 清空只清属性与辅助键，目录里的登记**保留**，
  别的类型仍写不进；只有显式 :meth:`drop` 才注销类型。

**用户隔离**：目录按**归属者**（图级 = 工作流主人；账号级 = 账号自己）分表，工作流这一层
把 ``owner_id`` 带进来（:class:`~tickneko.workflow.nodes.base.NodeExecutionContext`），
中枢只认它 —— 不知道是谁的变量，账号级当场抛（不许瞎写）。

**为什么要有用户目录**：枚举变量如果按 ``workflow:*`` 扫库就是 O(整个缓存)；目录一层是
「每个归属者一张 hash」，数量远小于变量本体，读一次 ``HGETALL`` 就拿到全部候选，顺带把
**变量类型**（节点注册的，见 ``VariableViewer.type_id``）也带出来，不用再反查图。
"""
from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from tickneko.core.cache.interfaces import CacheBackend

from .keys import (
    DIRECTORY_PATTERN,
    VARIABLE_ATTRIBUTES_READ_ONLY,
    VariableKey,
    account_key,
    directory_key,
    graph_key,
)

__all__ = ["VariableCenter", "VariableTypeConflict"]


class VariableTypeConflict(RuntimeError):
    """同一个变量已被别的类型登记，禁止覆盖改写。

    变量名即身份：一个逻辑变量只属于**最先写它的那种类型**（节点注册的 ``type_id``，
    见 ``VariableViewer.type_id``）。之后别的类型再来写（工作流节点写、接口层改写），
    中枢一律拒绝 —— 想换类型只能先删除（``drop`` 整族清）再让新类型写。
    """


class VariableCenter:
    """变量中枢：键布局 + 用户目录（类型表）+ 属性表的唯一出入口。"""

    def __init__(self, cache: CacheBackend) -> None:
        self.cache = cache

    # ------------------------------------------------------------------ 键
    def key(
        self,
        scope: str,
        name: str,
        *,
        owner_id: str = "",
        workflow_id: str = "",
    ) -> VariableKey:
        """按作用域拼出变量的身份（节点 / 接口层都用它，不自己拼字符串）。

        :raises ValueError: 作用域不是 graph / account；账号级没给归属；名字为空或带冒号。
        """
        if scope == "account":
            return account_key(owner_id, name)
        if scope != "graph":
            raise ValueError(f"作用域要 graph / account 之一：{scope!r}")
        return graph_key(workflow_id, name)

    # ------------------------------------------------------------ 用户目录
    async def sync(self, key: VariableKey, type_id: str, *, owner_id: str = "") -> None:
        """登记入口：**与 :meth:`remember` 共用同一个守卫**，任何登记路径都不可覆盖别的类型。

        本体在（string 本体**空串也算在**）：过守卫后登记 field = 完整变量键、value = 类型 id；
        本体没了（清空列表 / 字典会让键消失）：**保留目录里的登记**（类型墓碑）—— 弹空 ≠
        删除，类型跟着变量身份走，直到显式 :meth:`drop` 才注销。

        ``owner_id`` 是**归属者**：账号级键里自带（可省），图级键不带 —— 调用方得把分布
        列表填的主人带进来，否则只能落进「不知道是谁」的空目录。
        """
        await self.guard(key, type_id, owner_id=owner_id)
        await self._sync(
            key, type_id if await self.cache.exists(key.full) else None, owner_id=owner_id
        )

    async def type_of(self, key: VariableKey, *, owner_id: str = "") -> str:
        """读目录里登记的变量类型；没登记过（含老数据只塞了键没写类型）返回空串。"""
        return (
            await self.cache.hash_get(
                directory_key(self._owner(key, owner_id)), key.full
            )
            or ""
        )

    async def guard(
        self, key: VariableKey, type_id: str, *, owner_id: str = ""
    ) -> None:
        """写本体前的类型守卫：变量已被**别的类型**登记 -> 当场报错，禁止覆盖。

        判据是用户目录里登记的类型（写它的节点声明的 ``type_id``）：没登记（新变量 /
        老数据）放行，登记过且一致（同类型再写）放行，不一致直接抛
        :class:`VariableTypeConflict`。空登记（历史数据只塞了键没写类型）视同未登记。
        """
        existing = await self.type_of(key, owner_id=owner_id)
        if existing and existing != type_id:
            raise VariableTypeConflict(
                f"变量 {key.full} 已被 {existing} 类型登记，{type_id} 类型不能覆盖"
                "（一个变量只属于一种类型，想换类型请先删除）"
            )

    async def write_variable(
        self,
        key: VariableKey,
        type_id: str,
        writer: Callable[[str], Awaitable[Any] | Any],
        *,
        owner_id: str = "",
        read_only: bool = False,
    ) -> Any:
        """变量层**唯一写入口**：守卫 -> 执行写动作 -> 报到，三步收在这一处。

        调用方只描述「以什么类型、怎么写」：``type_id`` 是写它的那种变量的类型 id
        （``VariableViewer.type_id``），``writer`` 是**实际写本体的动作**（可同步可异步，
        返回值原样透出）。**键不用节点拼**：中枢把完整键（``key.full``）注入 writer 的
        唯一参数，节点只写「这个键怎么动」。内部顺序是 ``guard -> writer -> remember``：
        类型冲突在写本体**之前**就被拦下，报错时本体没被改写；写成功后目录与属性表自动
        保持同步。想换类型只能先 :meth:`drop` 整族删掉再让新类型写。
        """
        await self.guard(key, type_id, owner_id=owner_id)
        result = writer(key.full)
        if inspect.isawaitable(result):
            result = await result
        await self.remember(key, type_id, owner_id=owner_id, read_only=read_only)
        return result

    async def remember(
        self,
        key: VariableKey,
        type_id: str,
        *,
        owner_id: str = "",
        read_only: bool = False,
    ) -> None:
        """写完变量后的报到：登记目录 + 落属性表（这种变量生来是否只读）。

        先过 :meth:`guard`：就算调用方忘了在写本体前检查，类型冲突也会在这里兜住报错；
        ``read_only`` **只在首次登记时落**（属性表里还没有这个字段才算首次）—— 后写者不能
        翻转别人定下的只读口径（同 :meth:`write_variable` 的语义）。
        """
        await self.guard(key, type_id, owner_id=owner_id)
        await self._sync(key, type_id, owner_id=owner_id)
        if (
            await self.cache.hash_get(key.attributes, VARIABLE_ATTRIBUTES_READ_ONLY)
            is None
        ):
            await self.set_attributes(
                key, {VARIABLE_ATTRIBUTES_READ_ONLY: "true" if read_only else "false"}
            )

    async def forget(self, key: VariableKey) -> None:
        """本体消失（弹空 / 被删）后的清理：属性表 + 节点私有结构清掉，**目录登记保留**。

        类型墓碑：弹空 ≠ 删除 —— 本体没了目录里的类型还在，别的类型写不进；要真正注销
        类型只能走显式 :meth:`drop`（接口删除）。节点私有段叫什么由节点自己定，中枢按
        ``{本体}:*`` 收一遍这个变量自己的命名空间 —— 范围就一个变量，很窄。
        """
        await self.cache.delete(key.attributes)
        artifacts = await self.cache.keys(f"{key.full}:*")
        if artifacts:
            await self.cache.delete_many(artifacts)

    async def drop(self, key: VariableKey, *, owner_id: str = "") -> None:
        """删掉一个逻辑变量的**整族键**并**注销目录登记** —— 唯一让类型消失的入口。

        节点私有段叫什么由节点自己定（如 ds-list 的 ``:counts``），中枢不该也不认识它，
        所以按 ``{本体}:*`` 收一遍这个变量自己的命名空间 —— 范围就一个变量，很窄。
        """
        await self.cache.delete(key.full)
        await self.forget(key)
        await self.cache.hash_delete(directory_key(self._owner(key, owner_id)), key.full)

    async def _sync(
        self, key: VariableKey, type_id: str | None, *, owner_id: str = ""
    ) -> None:
        """目录同步的**实际动作**：给了类型就登记；没给（本体消失）**保留墓碑**不注销。"""
        if type_id is None:
            return  # 类型墓碑：本体消失 ≠ 删除，登记保留到显式 drop
        directory = directory_key(self._owner(key, owner_id))
        await self.cache.hash_set(directory, {key.full: type_id})

    @staticmethod
    def _owner(key: VariableKey, owner_id: str = "") -> str:
        """目录归属：账号级键里自带归属（键说了算），图级键不带，靠调用方把主人带进来。"""
        return key.owner_id or owner_id

    async def directory(self, owner_id: str) -> dict[str, str]:
        """某个归属者的目录：``{完整变量键: 变量类型}``。"""
        return await self.cache.hash_get_all(directory_key(owner_id))

    async def owners(self) -> list[str]:
        """所有登记过变量的归属者 id（管理员全量视图只看目录这一层）。"""
        keys = await self.cache.keys(DIRECTORY_PATTERN)
        return sorted(key.rsplit(":", 1)[-1] for key in keys)

    # -------------------------------------------------------------- 属性表
    async def attributes(self, key: VariableKey) -> dict[str, str]:
        """读属性表（``{本体}:meta``）：没有就是空表。"""
        return await self.cache.hash_get_all(key.attributes)

    async def set_attributes(self, key: VariableKey, values: Mapping[str, str]) -> None:
        """写属性表：只覆盖给了的字段，别的属性不动。"""
        if values:
            await self.cache.hash_set(key.attributes, dict(values))

    async def is_read_only(self, key: VariableKey) -> bool:
        """属性表里 ``read_only`` 是否为真（没写过就当可改）。"""
        value = await self.cache.hash_get(key.attributes, VARIABLE_ATTRIBUTES_READ_ONLY)
        return value is not None and value.strip().lower() in ("1", "true", "yes")
