"""节点查看器契约与真实缓存语义；Redis 沿用项目的本机可用时集成验证。"""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest

from tickneko.core.cache import Cache, CacheOptions, RedisOptions
from tickneko.variables import (
    VariableCenter,
    VariableScope,
    VariableTypeConflict,
)
from tickneko.variables.viewer import NodeLike
from tickneko.workflow.models import WorkflowNode
from tickneko.workflow.nodes import (
    JsonViewer,
    ListViewer,
    NodeExecutionContext,
    NodeSpec,
    VariableContext,
    VariableRule,
    declare_node_type,
    exec_cache,
    exec_ds_list_append,
    exec_ds_list_contains,
    exec_ds_list_length,
    exec_ds_list_pop,
    exec_ds_list_pop_left,
    get_spec,
    register_executor,
    register_node,
    registered_variable_viewers,
    registry,
)
from tickneko.workflow.nodes.ds_container import COUNTS_SEGMENT, DsListViewer
from tickneko.workflow.nodes.ds_dict import DsDictViewer


@pytest.fixture
async def memory() -> AsyncIterator[Cache]:
    cache = Cache(CacheOptions(backend="memory"))
    await cache.start()
    try:
        yield cache
    finally:
        await cache.stop()


@pytest.fixture(params=["memory", "redis"])
async def family_cache(request: pytest.FixtureRequest) -> AsyncIterator[Cache]:
    if request.param == "redis":
        pytest.importorskip("redis")
        try:
            with socket.create_connection(("127.0.0.1", 6379), timeout=0.25):
                pass
        except OSError:
            pytest.skip("本机没有可用的 Redis，跳过键族集成用例")
    cache = Cache(
        CacheOptions(
            backend=request.param,
            namespace=f"tickneko:viewer-test:{uuid4().hex}",
            redis=RedisOptions(socket_timeout=1.0, connect_retries=0),
        )
    )
    await cache.start()
    try:
        yield cache
    finally:
        await cache.clear()
        await cache.stop()


def context(
    cache: Cache,
    *,
    scope: VariableScope = "graph",
    owner_id: str = "u-admin",
    workflow_id: str = "w1",
    name: str = "队列",
    node: NodeLike | None = None,
    type_id: str = "",
) -> VariableContext:
    """造一个经鉴权绑定好的上下文（生产里由服务端算，测试直造）。"""
    return VariableContext(
        cache,
        VariableCenter(cache),
        scope,
        owner_id,
        workflow_id,
        name,
        node,
        type_id,
    )


def test_all_registration_paths_collect_viewers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(registry, "_SPECS", dict(registry._SPECS))
    assert NodeSpec("plain").variable_viewer is None
    declare_node_type("viewer-declared", variable_viewer=DsListViewer)

    @register_node("viewer-decorated", variable_viewer=DsListViewer)
    async def execute(
        node: WorkflowNode, ctx: NodeExecutionContext
    ) -> dict[str, object]:
        return {}

    register_executor("viewer-manual", execute, variable_viewer=DsListViewer)
    for name in ("viewer-declared", "viewer-decorated", "viewer-manual", "ds-list-pop"):
        spec = get_spec(name)
        assert spec is not None and spec.variable_viewer is DsListViewer
    assert registered_variable_viewers().count(DsListViewer) == 1


def test_viewer_rules_own_scope_name_and_actions(memory: Cache) -> None:
    node = WorkflowNode(
        id="write",
        type="custom",
        config={"slot": "队列", "scope": "workflow", "action": "write"},
    )
    bound = context(memory, node=node)
    assert VariableRule(key_field="slot", actions=("write",)).matches(bound)
    assert not VariableRule(key_field="slot", actions=("read",)).matches(bound)
    assert not VariableRule(key_field="slot", scopes=("account",)).matches(bound)
    assert VariableRule(name_pattern="队.*").matches(context(memory))


async def test_ds_list_replace_clear_and_recreate(family_cache: Cache) -> None:
    bound = context(family_cache)
    viewer = DsListViewer(bound)
    await viewer.add(items=["a", "a", "b"])
    view = await viewer.view()
    assert (view.type, view.data, view.length) == ("list", ["a", "a", "b"], 3)
    counts = f"{bound.full_key}:{COUNTS_SEGMENT}"
    assert await family_cache.hash_get_all(counts) == {"a": "2", "b": "1"}
    await viewer.add(items=["b", "b"])
    assert await family_cache.list_range(bound.full_key) == ["b", "b"]
    assert await family_cache.hash_get_all(counts) == {"b": "2"}
    await viewer.add(items=[])
    assert not await family_cache.exists(bound.full_key)
    assert not await family_cache.exists(counts)
    await viewer.add(item="")
    assert await family_cache.list_range(bound.full_key) == [""]
    assert await family_cache.hash_get_all(counts) == {"": "1"}


async def test_runtime_pops_delete_last_hash_field(family_cache: Cache) -> None:
    ctx = NodeExecutionContext(owner_id="u-admin", workflow_id="w1", cache=family_cache)
    node = WorkflowNode(id="queue", type="ds-list-append", config={"key": "队列"})
    for item in ("", "a", "a"):
        ctx.inputs = {"item": item}
        await exec_ds_list_append(node, ctx)
    key = context(family_cache).full_key
    counts = f"{key}:{COUNTS_SEGMENT}"
    assert (await exec_ds_list_pop_left(node, ctx))["value_out"] == ""
    assert not await family_cache.hash_exists(counts, "")
    assert (await exec_ds_list_pop(node, ctx))["value_out"] == "a"
    ctx.inputs = {"item": "a"}
    assert (await exec_ds_list_contains(node, ctx))["flag"] == "true"
    assert (await exec_ds_list_pop(node, ctx))["value_out"] == "a"
    assert not await family_cache.exists(counts)  # 真 Redis 的 HDEL 删空行为也验证。
    await family_cache.hash_set(counts, {"stale": "10"})
    ctx.inputs = {"default": "空了"}
    assert (await exec_ds_list_pop(node, ctx))["value_out"] == "空了"
    assert not await family_cache.exists(counts)


async def test_node_write_registers_graph_variable_under_graph_owner(
    memory: Cache,
) -> None:
    """图级变量的键里没有归属，中枢得靠节点 ctx 把**图的主人**带进目录。"""
    ctx = NodeExecutionContext(owner_id="u-admin", workflow_id="w1", cache=memory)
    node = WorkflowNode(id="queue", type="ds-list-append", config={"key": "队列"})
    ctx.inputs = {"item": "a"}
    await exec_ds_list_append(node, ctx)
    key = context(memory).full_key
    assert await memory.hash_get_all("workflow:index:acct:u-admin") == {
        key: DsListViewer.type_id
    }
    # 属性表也报到了（生来可改）：read_only=false
    assert await memory.hash_get_all(f"{key}:meta") == {"read_only": "false"}
    # 没有归属的「空目录」不该被用到
    assert not await memory.exists("workflow:index:acct:")


async def test_pop_empty_keeps_registered_type_tombstone(memory: Cache) -> None:
    """弹空 ≠ 删除：ds-list 弹空后目录登记保留（类型墓碑），cache 再来写照样被拦。"""
    ctx = NodeExecutionContext(owner_id="u-admin", workflow_id="w1", cache=memory)
    node = WorkflowNode(id="queue", type="ds-list-append", config={"key": "队列"})
    ctx.inputs = {"item": "a"}
    await exec_ds_list_append(node, ctx)
    key = context(memory).full_key
    assert await memory.hash_get_all("workflow:index:acct:u-admin") == {
        key: DsListViewer.type_id
    }

    pop_node = WorkflowNode(id="qpop", type="ds-list-pop", config={"key": "队列"})
    ctx.inputs = {"default": "没了"}
    assert (await exec_ds_list_pop(pop_node, ctx))["value_out"] == "a"
    assert not await memory.exists(key)  # 本体没了
    assert await memory.hash_get_all("workflow:index:acct:u-admin") == {
        key: DsListViewer.type_id  # 类型墓碑还在，别的类型写不进来
    }

    cache_node = WorkflowNode(
        id="c1", type="cache", config={"action": "set", "key": "队列"}
    )
    ctx.inputs = {"value": "x"}
    with pytest.raises(VariableTypeConflict, match="已被 ds-list 类型登记"):
        await exec_cache(cache_node, ctx)
    assert not await memory.exists(key)  # 写被拦在改本体之前

    # 只有显式 drop 才注销类型，之后别的类型才能写
    await ctx.variables.drop(ctx.variable("workflow", "队列"), owner_id="u-admin")
    assert not await memory.hash_exists("workflow:index:acct:u-admin", key)
    await exec_cache(cache_node, ctx)
    assert await memory.get(key) == "x"
    assert await memory.hash_get_all("workflow:index:acct:u-admin") == {
        key: "cache"
    }


async def test_clear_keeps_registered_type_tombstone(memory: Cache) -> None:
    """清空 ≠ 删除：ds-list 清空（本体键消失）后目录登记保留，别的类型仍写不进来。"""
    bound = context(memory)
    viewer = DsListViewer(bound)
    await viewer.add(items=["a"])
    await viewer.add(items=[])  # 清空：本体键消失
    key = bound.full_key
    assert not await memory.exists(key)
    assert await memory.hash_get_all("workflow:index:acct:u-admin") == {
        key: DsListViewer.type_id  # 类型墓碑
    }
    ctx = NodeExecutionContext(owner_id="u-admin", workflow_id="w1", cache=memory)
    cache_node = WorkflowNode(
        id="c1", type="cache", config={"action": "set", "key": "队列"}
    )
    ctx.inputs = {"value": "x"}
    with pytest.raises(VariableTypeConflict, match="已被 ds-list 类型登记"):
        await exec_cache(cache_node, ctx)
    assert not await memory.exists(key)


async def test_read_only_is_set_only_on_first_registration(memory: Cache) -> None:
    """E：read_only 只在首次登记时落，后写者不能翻转先定下的口径。"""
    center = VariableCenter(memory)
    key = NodeExecutionContext(
        owner_id="u-admin", workflow_id="w1", cache=memory
    ).variable("workflow", "队列")
    await center.remember(key, "ds-list", owner_id="u-admin", read_only=True)
    await center.write_variable(
        key,
        "ds-list",
        lambda full: memory.set(full, "x"),
        owner_id="u-admin",
        read_only=False,  # 后写者想翻回「可改」-> 无效
    )
    assert await memory.hash_get_all(key.attributes) == {"read_only": "true"}
    assert await center.is_read_only(key)


async def test_body_is_authority_probe_and_view_are_read_only(memory: Cache) -> None:
    bound = context(memory)
    counts = f"{bound.full_key}:{COUNTS_SEGMENT}"
    await memory.list_push_right(bound.full_key, "a", "a", "b")
    viewer = DsListViewer(bound)
    assert not await DsListViewer.probe(bound)
    assert (await viewer.view()).length == 3
    assert not await memory.exists(counts)
    await memory.hash_set(counts, {"wrong": "999"})
    assert await DsListViewer.probe(bound)
    assert (await viewer.view()).data == ["a", "a", "b"]
    ctx = NodeExecutionContext(owner_id="u-admin", workflow_id="w1", cache=memory)
    node = WorkflowNode(id="queue", type="ds-list-length", config={"key": "队列"})
    assert (await exec_ds_list_length(node, ctx))["count"] == "3"
    assert await memory.hash_get_all(counts) == {"wrong": "999"}


async def test_add_rebuilds_missing_auxiliary_counts(memory: Cache) -> None:
    """本体非空而辅助计数缺失（老数据 / 手工塞键）时，已确认的 ds-list 新增按本体重建。"""
    bound = context(memory)
    counts = f"{bound.full_key}:{COUNTS_SEGMENT}"
    await memory.list_push_right(bound.full_key, "a", "a", "b")
    assert not await memory.exists(counts)
    assert not await DsListViewer.probe(bound)  # 光有物理 list、没有键族证据不认。
    assert await memory.list_length(bound.full_key) == 3
    await DsListViewer(bound).add(item="a")
    assert await memory.hash_get_all(counts) == {"a": "3", "b": "1"}


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"item": "x", "items": []},
        {"items": {}},
        {"items": ["x", {}]},
        {"item": []},
        {"item": "x", "unknown": True},
        {"items": None},
    ],
)
async def test_list_validation_finishes_before_writes(
    memory: Cache, params: dict[str, object]
) -> None:
    bound = context(memory)
    viewer = DsListViewer(bound)
    await viewer.add(items=["original"])
    with pytest.raises(ValueError):
        await viewer.add(**params)
    assert await memory.list_range(bound.full_key) == ["original"]
    assert await memory.hash_get_all(f"{bound.full_key}:{COUNTS_SEGMENT}") == {
        "original": "1"
    }


async def test_dict_full_replace_and_scalar_text_encoding(memory: Cache) -> None:
    bound = context(memory, scope="account", workflow_id="", name="字典")
    viewer = DsDictViewer(bound)
    await viewer.add(fields={"old": "x", "kept": "y"})
    await viewer.add(fields={"kept": "new", "zero": 0, "false": False, "empty": None})
    assert (await viewer.view()).data == {
        "kept": "new",
        "zero": "0",
        "false": "False",
        "empty": "",
    }
    with pytest.raises(ValueError):
        await viewer.add(fields={"valid": "x", "invalid": []})
    assert not await memory.hash_exists(bound.full_key, "valid")
    await viewer.add(fields={})
    assert not await memory.exists(bound.full_key)
    await viewer.add(field="new", value="")
    assert (await viewer.view()).data == {"new": ""}


@pytest.mark.parametrize("value", [0, False, None, [], {}])
async def test_json_keeps_value_types(memory: Cache, value: object) -> None:
    bound = context(memory, scope="account", workflow_id="", name="JSON")
    viewer = JsonViewer(bound)
    await viewer.add(value=value)
    result = await viewer.view()
    assert result.type == "json" and result.data == value
    assert type(result.data) is type(value)
    assert await JsonViewer.probe(bound)


async def test_registered_plain_list_can_edit_without_creating_family(
    memory: Cache,
) -> None:
    bound = context(memory)
    viewer = ListViewer(bound)  # 已有节点声明，而非来源丢失时的只读 probe。
    await viewer.add(items=["a", "a", ""])
    assert (await viewer.view()).data == ["a", "a", ""]
    assert not await memory.exists(f"{bound.full_key}:{COUNTS_SEGMENT}")


async def test_viewer_label_is_registered_and_carried_by_view(memory: Cache) -> None:
    """类型名由查看器自己注册：同一 view_type 下不同节点的结构靠它区分。"""
    assert ListViewer.label == "列表"
    assert DsListViewer.label == "列表·计数"  # 本体之外还有 :counts 计数，可整体覆盖
    assert DsDictViewer.label == "键值对"
    # result() 把注册的名字带进 view，接口层不再自己拼
    result = await DsListViewer(context(memory), editable=True).view()
    assert result.type == "list" and result.label == "列表·计数"
