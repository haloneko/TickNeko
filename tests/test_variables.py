"""变量查看接口的测试：作用域 / 归属过滤，以及「管理员看全部、普通用户只看自己」的权限口径。

请求不走真实网络：用 ``httpx.AsyncClient`` 挂 ``ASGITransport`` 直接打进 ASGI 应用。
变量写在缓存里（本体键 ``workflow:graph:…`` / ``workflow:acct:…``，外加用户目录
``workflow:index:acct:{归属}`` 里的一条登记），接口再把登记反解成结构化字段 ——
这里验证的正是这一步与归属隔离。

需要 ``fastapi`` / ``httpx``；没装就整文件跳过。
"""
from __future__ import annotations

import json
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from contextlib import asynccontextmanager

import pytest

pytest.importorskip("fastapi", reason='接口层要装 fastapi：pip install "tickneko[api]"')
pytest.importorskip("httpx", reason='接口层测试用 httpx 发请求：pip install "tickneko[dev]"')

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine  # noqa: E402

from tickneko.api import ApiOptions, create_app  # noqa: E402
from tickneko.api.services.user.security import Pbkdf2PasswordHasher  # noqa: E402
from tickneko.api.services.user.store_sql import SqlUserStore  # noqa: E402
from tickneko.core.cache import Cache, CacheOptions  # noqa: E402
from tickneko.workflow import SqlWorkflowStore  # noqa: E402
from tickneko.workflow.nodes import registry  # noqa: E402
from tickneko.workflow.nodes import (  # noqa: E402
    StringViewer, VariableContext, declare_node_type, register_executor,
)
from tickneko.workflow.nodes.ds_container import DsListViewer  # noqa: E402

#: 演示账号（见 tickneko.api.services.user.demo）—— 唯一自带的账号，且是管理员
ADMIN = {"account": "admin", "password": "tickneko-admin"}
#: 普通账号：由用例顺手注册（注册要昵称）
PLAIN = {"account": "robot", "password": "tickneko-robot", "nickname": "巡检机器人"}

LOGIN_PATH = "/api/auth/login"
REGISTER_PATH = "/api/auth/register"
VARIABLES_PATH = "/api/variables"

#: 测试用哈希迭代次数（生产默认 20 万次，用例不必每次重付这笔钱）
_TEST_HASHER = Pbkdf2PasswordHasher(iterations=1_000)


@asynccontextmanager
async def client_for(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    """一个直连 ASGI 应用的异步客户端（顺带把 app 的 lifespan 跑起来建表）。"""
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield client


@dataclass
class Env:
    """一个装配好的测试环境：客户端 + 缓存门面 + 工作流存储（用例自己往里塞数据）。"""

    client: httpx.AsyncClient
    cache: Cache
    workflows: SqlWorkflowStore
    app: FastAPI


@pytest.fixture
async def env() -> AsyncIterator[Env]:
    """接口层 + 一块内存 sqlite（用户 / 工作流）+ 一份跑起来的本地缓存。"""
    engine: AsyncEngine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        users = SqlUserStore(engine, hasher=_TEST_HASHER)
        await users.ensure_schema()
        await users.seed_demo()
        workflows = SqlWorkflowStore(engine)
        await workflows.ensure_schema()
        store = Cache(CacheOptions(backend="memory"))
        await store.start()
        try:
            app = create_app(
                ApiOptions(prefix="/api", token_ttl=1800.0),
                user_store=users,
                cache=store,
                workflow_store=workflows,
            )
            async with client_for(app) as client:
                yield Env(client=client, cache=store, workflows=workflows, app=app)
        finally:
            await store.stop()
    finally:
        await engine.dispose()


def auth(token: str) -> dict[str, str]:
    """带令牌的请求头。"""
    return {"Authorization": f"Bearer {token}"}


async def login(client: httpx.AsyncClient, creds: dict[str, str]) -> tuple[str, str]:
    """登录，返回 ``(令牌, 归属 id)``。"""
    response = await client.post(LOGIN_PATH, json=creds)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    return data["token"], data["user"]["id"]


async def register(client: httpx.AsyncClient, creds: dict[str, str]) -> tuple[str, str]:
    """注册一个普通账号并登录，返回 ``(令牌, 归属 id)``。"""
    response = await client.post(REGISTER_PATH, json=creds)
    assert response.status_code == 201, response.text
    return await login(client, creds)


def page_of(response: httpx.Response) -> dict[str, object]:
    """取出响应壳里的 ``data``（顺带确认是成功响应）。"""
    assert response.status_code == 200, response.text
    return response.json()["data"]


async def index_variable(
    cache: Cache, owner: str, *keys: str, type_id: str = ""
) -> None:
    """把已写好的变量键登记进所属用户的目录 map（生产写路径会做；测试直塞缓存时补一手）。

    目录 map（``workflow:index:acct:{owner}``）的 field 就是完整变量键、value 是**变量类型**
    （节点注册的 ``type_id``；不给就空串，读取时回落到 probe），枚举只读它，不再扫变量本体。
    """
    if keys:
        await cache.hash_set(
            f"workflow:index:acct:{owner}", {key: type_id for key in keys}
        )


def isolate_viewers(monkeypatch: pytest.MonkeyPatch) -> None:
    """按用例隔离变量类型注册表：用例里临时声明的查看器别漏给别的用例。

    注册表是进程级的（节点模块 import 时就登记好了），而 ``type_id`` 全局唯一 —— 用例里
    定义的子类不隔离就会互相撞 ``type_id``，也会被后面的用例 probe 到；
    「有节点在维护」那份名单同样要隔离（可手工新建的类型照它筛）。
    """
    from tickneko.variables import viewer as viewer_module

    monkeypatch.setattr(
        viewer_module, "_VIEWERS_BY_TYPE", dict(viewer_module._VIEWERS_BY_TYPE)
    )
    monkeypatch.setattr(
        viewer_module, "_NODE_VIEWER_TYPES", set(viewer_module._NODE_VIEWER_TYPES)
    )


class TestVariables:
    async def test_requires_login(self, env: Env) -> None:
        """没登录一律 401，不往外说有哪些变量。"""
        response = await env.client.get(VARIABLES_PATH)
        assert response.status_code == 401

    async def test_503_when_cache_is_not_wired(self) -> None:
        """没给 create_app 传缓存：503 并说清楚，而不是静默给一个空列表。"""
        app = create_app(ApiOptions(prefix="/api"), hasher=_TEST_HASHER)
        async with client_for(app) as client:
            token, _ = await login(client, ADMIN)
            response = await client.get(VARIABLES_PATH, headers=auth(token))
        assert response.status_code == 503
        assert "缓存未接入" in response.json()["error"]["message"]

    async def test_admin_sees_everyone_plain_user_only_self(self, env: Env) -> None:
        """管理员看得到所有人的变量；普通用户只看得到自己名下的。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        plain_token, plain_id = await register(env.client, PLAIN)
        graph = await env.workflows.create(admin_id, "图一")

        admin_key = f"workflow:acct:{admin_id}:日签"
        plain_key = f"workflow:acct:{plain_id}:计数"
        graph_key = f"workflow:graph:{graph.id}:计数"
        await env.cache.set(admin_key, "开")
        await env.cache.set(plain_key, "3")
        await env.cache.set(graph_key, "1")
        await index_variable(env.cache, admin_id, admin_key, graph_key)
        await index_variable(env.cache, plain_id, plain_key)

        # 管理员：三条都能看到，字段按作用域拆好
        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(admin_token)))
        assert page["total"] == 3
        rows = {(item["scope"], item["owner_id"], item["key"]): item for item in page["items"]}
        graph_row = rows[("graph", admin_id, "计数")]
        assert graph_row["workflow_id"] == graph.id
        assert "value" not in graph_row  # 列表只列元数据，值走详情接口
        assert graph_row["ttl"] is None  # 没设 TTL = 永不过期（JSON 里没有 Infinity）
        account_row = rows[("account", admin_id, "日签")]
        assert account_row["workflow_id"] == ""  # 账号级不挂在某张图上
        assert "value" not in account_row

        # 普通用户：只看得到自己那条（图级的图不是他的，也看不到）
        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(plain_token)))
        assert page["total"] == 1
        assert [item["owner_id"] for item in page["items"]] == [plain_id]

    async def test_hash_and_list_variables_are_readable(self, env: Env) -> None:
        """哈希 / 列表变量照常展示：hash 走 hash_get_all、list 走 list_range，都序列化成 JSON 文本。

        以前只认字符串键，对哈希发 ``GET`` 会撞 WRONGTYPE 把整页打成 500 —— 现在三种结构都能看。
        """
        admin_token, admin_id = await login(env.client, ADMIN)
        await env.cache.set(f"workflow:acct:{admin_id}:开关", "开")
        await env.cache.hash_set(
            f"workflow:acct:{admin_id}:配置", {"主题色": "蓝", "模式": "夜间"}
        )
        await env.cache.list_push_right(f"workflow:acct:{admin_id}:队列", "A", "B")
        await index_variable(
            env.cache,
            admin_id,
            f"workflow:acct:{admin_id}:开关",
            f"workflow:acct:{admin_id}:配置",
            f"workflow:acct:{admin_id}:队列",
        )

        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(admin_token)))
        assert page["total"] == 3
        rows = {item["key"]: item for item in page["items"]}
        assert rows["开关"]["type"] == "str"
        assert rows["配置"]["type"] == "dict"
        assert rows["队列"]["type"] == "list"

        # 内容照常走详情接口：hash 走 hash_get_all、list 走 list_range，都放进 data
        async def data_of(key: str) -> object:
            data = page_of(
                await env.client.get(
                    f"{VARIABLES_PATH}/value",
                    headers=auth(admin_token),
                    params={"scope": "account", "owner_id": admin_id, "key": key},
                )
            )
            return data["data"]

        assert await data_of("开关") == "开"
        assert await data_of("配置") == {"主题色": "蓝", "模式": "夜间"}
        assert await data_of("队列") == ["A", "B"]

    async def test_list_returns_metadata_only(self, env: Env) -> None:
        """列表接口只列元数据：类型照常解析，但本体值 / 长度不读不给（内容走 /value）。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        await env.cache.set(f"workflow:acct:{admin_id}:计数", "abc")
        await env.cache.list_push_right(f"workflow:acct:{admin_id}:队列", "A", "B")
        await index_variable(
            env.cache,
            admin_id,
            f"workflow:acct:{admin_id}:计数",
            f"workflow:acct:{admin_id}:队列",
        )

        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(admin_token)))
        assert page["total"] == 2
        rows = {item["key"]: item for item in page["items"]}
        # 类型来自来源反查 / 探测，不读本体也能给；值、长度、结构化数据一律不下发
        assert rows["计数"]["type"] == "str"
        assert "value" not in rows["计数"]
        assert rows["队列"]["type"] == "list"
        assert "data" not in rows["队列"]
        assert "length" not in rows["队列"]
        assert "value" not in rows["队列"]

    async def test_plain_user_cannot_ask_for_someone_else(self, env: Env) -> None:
        """普通用户显式写别人的归属 -> 403（和日志 / 工作流列表一个口径）。"""
        _, admin_id = await login(env.client, ADMIN)
        plain_token, _ = await register(env.client, PLAIN)
        await env.cache.set(f"workflow:acct:{admin_id}:日签", "开")

        response = await env.client.get(
            VARIABLES_PATH, headers=auth(plain_token), params={"owner_id": admin_id}
        )
        assert response.status_code == 403

    async def test_admin_can_filter_by_owner(self, env: Env) -> None:
        """管理员带 ``?owner_id=`` 就缩到那一个人。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        _, plain_id = await register(env.client, PLAIN)
        await env.cache.set(f"workflow:acct:{admin_id}:日签", "开")
        await env.cache.set(f"workflow:acct:{plain_id}:计数", "3")
        await index_variable(env.cache, admin_id, f"workflow:acct:{admin_id}:日签")
        await index_variable(env.cache, plain_id, f"workflow:acct:{plain_id}:计数")

        page = page_of(
            await env.client.get(
                VARIABLES_PATH, headers=auth(admin_token), params={"owner_id": plain_id}
            )
        )
        assert page["total"] == 1
        assert page["items"][0]["owner_id"] == plain_id

    async def test_scope_and_keyword_filters(self, env: Env) -> None:
        """作用域与变量名两个筛子各自生效。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        graph = await env.workflows.create(admin_id, "图一")
        await env.cache.set(f"workflow:acct:{admin_id}:日签", "开")
        await env.cache.set(f"workflow:graph:{graph.id}:计数", "1")
        await index_variable(
            env.cache,
            admin_id,
            f"workflow:acct:{admin_id}:日签",
            f"workflow:graph:{graph.id}:计数",
        )

        page = page_of(
            await env.client.get(
                VARIABLES_PATH, headers=auth(admin_token), params={"scope": "graph"}
            )
        )
        assert page["total"] == 1
        assert page["items"][0]["scope"] == "graph"

        page = page_of(
            await env.client.get(
                VARIABLES_PATH, headers=auth(admin_token), params={"query": "日签"}
            )
        )
        assert page["total"] == 1
        assert page["items"][0]["key"] == "日签"

    async def test_bad_scope_is_422(self, env: Env) -> None:
        """作用域写错是写错了，别静默当成「一个都没有」。"""
        admin_token, _ = await login(env.client, ADMIN)
        response = await env.client.get(
            VARIABLES_PATH, headers=auth(admin_token), params={"scope": "nope"}
        )
        assert response.status_code == 422

    async def test_pagination(self, env: Env) -> None:
        """一页给 ``limit`` 条，``total`` 是不受分页限制的命中总数。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        for index in range(5):
            key = f"workflow:acct:{admin_id}:k{index}"
            await env.cache.set(key, str(index))
            await index_variable(env.cache, admin_id, key)

        page = page_of(
            await env.client.get(
                VARIABLES_PATH, headers=auth(admin_token), params={"limit": 2, "offset": 0}
            )
        )
        assert page["total"] == 5
        assert len(page["items"]) == 2

        page = page_of(
            await env.client.get(
                VARIABLES_PATH, headers=auth(admin_token), params={"limit": 2, "offset": 4}
            )
        )
        assert page["total"] == 5
        assert len(page["items"]) == 1

    async def test_unrelated_keys_are_ignored(self, env: Env) -> None:
        """缓存里别的系统的键（会话令牌等）不算变量。"""
        admin_token, _ = await login(env.client, ADMIN)
        await env.cache.set("auth:token:abc", "x")
        await env.cache.set("something:else", "y")

        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(admin_token)))
        assert page["total"] == 0

    async def test_orphan_graph_variable_is_admin_only(self, env: Env) -> None:
        """图被删了：变量还留在**原归属者**的目录里 —— 普通用户看不到，管理员照常看到。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        plain_token, _ = await register(env.client, PLAIN)
        graph = await env.workflows.create(admin_id, "图一")
        key = f"workflow:graph:{graph.id}:计数"
        await env.cache.set(key, "1")
        await index_variable(env.cache, admin_id, key)
        assert await env.workflows.delete(graph.id) is True

        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(plain_token)))
        assert page["total"] == 0

        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(admin_token)))
        assert page["total"] == 1
        assert page["items"][0]["owner_id"] == admin_id
        assert page["items"][0]["workflow_id"] == graph.id


async def writer_graph(env: Env, owner: str, node_type: str = "ds-list-append", key: str = "队列") -> str:
    graph = await env.workflows.create(owner, "变量写入图")
    await env.workflows.save_draft(graph.id, json.dumps({
        "nodes": [{"id": "writer", "type": node_type, "config": {"key": key, "scope": "workflow", "action": "set"}}],
        "edges": [],
    }))
    return graph.id


def graph_params(ident: str, key: str = "队列") -> dict[str, str]:
    return {"scope": "graph", "workflow_id": ident, "key": key}


async def type_catalog(env: Env, token: str) -> dict[str, dict[str, object]]:
    """可手工新建的类型清单（GET /variables/types），按 ``type_id`` 索引。"""
    rows = page_of(await env.client.get(f"{VARIABLES_PATH}/types", headers=auth(token)))
    return {row["type_id"]: row for row in rows}


class TestVariableViewers:
    async def test_discovery_filters_families_before_pagination(self, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
        token, owner = await login(env.client, ADMIN)
        key_a = f"workflow:acct:{owner}:a"
        await env.cache.list_push_right(key_a, "a", "a", "b")
        await env.cache.hash_set(f"{key_a}:counts", {"a": "2", "b": "1"})
        await env.cache.hash_set(f"{key_a}:meta", {"read_only": "false"})  # 属性表也不是变量
        key_b = f"workflow:acct:{owner}:b"
        await env.cache.set(key_b, "text")
        await env.cache.hash_set(f"workflow:acct:{owner}:orphan:counts", {"stale": "1"})
        # 只有本体键登记进目录；:counts / :meta / 孤儿辅助键都是辅助键，不该被枚举出来。
        await index_variable(env.cache, owner, key_a, type_id=DsListViewer.type_id)
        await index_variable(env.cache, owner, key_b, type_id="str")
        keys = env.cache.keys

        async def duplicates(pattern: str = "*") -> list[str]:
            rows = await keys(pattern)
            return rows + rows  # SCAN 可以重复返回；同一目录字段仍只计一次。

        monkeypatch.setattr(env.cache, "keys", duplicates)
        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(token), params={"limit": 1}))
        assert page["total"] == 2
        assert page["items"][0]["key"] == "a"
        # 列表只列元数据：类型仍在，本体值 / 长度不下发
        assert page["items"][0]["type"] == "list"
        # 类型直接取目录里登记的值（不用 probe）：列表 / 列表·计数 靠登记的 type_id 区分
        assert page["items"][0]["type_label"] == "列表·计数"
        assert "data" not in page["items"][0]
        assert "length" not in page["items"][0]
        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(token), params={"limit": 1, "offset": 1}))
        assert [row["key"] for row in page["items"]] == ["b"]
        assert page_of(await env.client.get(VARIABLES_PATH, headers=auth(token), params={"query": ":counts"}))["total"] == 0

    async def test_node_source_handles_missing_counts_and_recreates_after_clear(self, env: Env) -> None:
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner)
        key = f"workflow:graph:{ident}:队列"
        await env.cache.list_push_right(key, "a", "a", "b")
        params = graph_params(ident)
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params))
        assert data["editable"] and data["length"] == 3
        assert not await env.cache.exists(f"{key}:counts")  # view 不做修复。
        data = page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"item": "b"}))
        assert data["data"] == ["a", "a", "b", "b"]
        assert await env.cache.hash_get_all(f"{key}:counts") == {"a": "2", "b": "2"}
        data = page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"items": ["b", "b"]}))
        assert data["length"] == 2 and await env.cache.hash_get_all(f"{key}:counts") == {"b": "2"}
        page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"items": []}))
        assert not await env.cache.exists(key) and not await env.cache.exists(f"{key}:counts")
        assert page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params))["data"] == []
        data = page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"item": ""}))
        assert data["data"] == [""] and await env.cache.hash_get_all(f"{key}:counts") == {"": "1"}

    @pytest.mark.parametrize("scope", ["account", "orphan", "missing-node", "invalid-graph"])
    async def test_probe_fallback_preserves_family_linkage(self, env: Env, scope: str) -> None:
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner, node_type="unloaded-extension")
        if scope == "orphan":
            await env.workflows.delete(ident)
        if scope == "invalid-graph":
            await env.workflows.save_draft(ident, "invalid JSON")
        params = {"scope": "account", "owner_id": owner, "key": "队列"} if scope == "account" else graph_params(ident)
        key = f"workflow:acct:{owner}:队列" if scope == "account" else f"workflow:graph:{ident}:队列"
        await env.cache.list_push_right(key, "a", "a")
        await env.cache.hash_set(f"{key}:counts", {"a": "2"})
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params))
        assert data["editable"]
        page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"items": ["b", "b"]}))
        assert await env.cache.hash_get_all(f"{key}:counts") == {"b": "2"}

    @pytest.mark.parametrize("orphan", [False, True])
    async def test_unidentified_list_is_read_only(self, env: Env, orphan: bool) -> None:
        token, owner = await login(env.client, ADMIN)
        params = {"scope": "graph", "workflow_id": "deleted", "key": "队列"} if orphan else {"scope": "account", "owner_id": owner, "key": "队列"}
        key = "workflow:graph:deleted:队列" if orphan else f"workflow:acct:{owner}:队列"
        await env.cache.list_push_right(key, "a")
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params))
        assert data["type"] == "list" and data["data"] == ["a"] and not data["editable"]
        response = await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"items": ["bad"]})
        assert response.status_code == 409
        assert await env.cache.list_range(key) == ["a"]
        assert not await env.cache.exists(f"{key}:counts")

    async def test_live_node_without_viewer_cannot_use_fallback(self, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(registry, "_SPECS", dict(registry._SPECS))
        declare_node_type("private-variable")
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner, "private-variable")
        key = f"workflow:graph:{ident}:队列"
        await env.cache.list_push_right(key, "a")
        await env.cache.hash_set(f"{key}:counts", {"a": "1"})
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=graph_params(ident)))
        assert data["type"] is None and not data["editable"] and "未开放" in data["reason"]
        response = await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=graph_params(ident), json={"item": "b"})
        assert response.status_code == 409 and await env.cache.list_range(key) == ["a"]

    @pytest.mark.parametrize("body", [{}, {"item": "x", "items": []}, {"items": ["x", {}]}, {"items": "x"}, {"item": "x", "unknown": 0}, {"key": "else", "item": "x"}, {"item": "x", "self": 0}])
    async def test_viewer_errors_are_422_and_leave_data_intact(self, env: Env, body: dict[str, object]) -> None:
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner)
        key = f"workflow:graph:{ident}:队列"
        await env.cache.list_push_right(key, "original")
        response = await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=graph_params(ident), json=body)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
        assert await env.cache.list_range(key) == ["original"]
        assert not await env.cache.exists(f"{key}:counts")

    async def test_account_dict_and_json_full_save(self, env: Env) -> None:
        token, owner = await login(env.client, ADMIN)
        params = {"scope": "account", "owner_id": owner, "key": "配置"}
        key = f"workflow:acct:{owner}:配置"
        await env.cache.hash_set(key, {"old": "x", "kept": "y"})
        data = page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"fields": {"new": ""}}))
        assert data["type"] == "dict" and data["data"] == {"new": ""}
        page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"fields": {}}))
        assert not await env.cache.exists(key)
        params["key"] = "JSON"
        await env.cache.set_json(f"workflow:acct:{owner}:JSON", {"initial": True})
        for value in (False, 0, None):
            data = page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"value": value}))
            assert data["type"] == "json" and type(data["data"]) is type(value) and data["data"] == value

    async def test_extension_receives_complete_body_and_trusted_context(self, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(registry, "_SPECS", dict(registry._SPECS))
        isolate_viewers(monkeypatch)
        seen: list[tuple[dict[str, object], VariableContext]] = []

        class ExtensionViewer(StringViewer):
            type_id = "extended-variable"

            async def add(self, **params: object) -> None:
                seen.append((params, self.context))
                await self.context.cache.set(self.context.full_key, "updated")

        declare_node_type("extended-variable", variable_viewer=ExtensionViewer)
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner, "extended-variable")
        await env.cache.set(f"workflow:graph:{ident}:队列", "initial")
        body = {"value": "x", "option": False, "offset": 0, "owner_id": "injected", "context": {"key": "else"}}
        page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=graph_params(ident), json=body))
        assert seen[0][0] == body
        assert seen[0][1].owner_id == owner and seen[0][1].name == "队列"

    async def test_equal_priority_viewers_disable_writes(self, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(registry, "_SPECS", dict(registry._SPECS))
        isolate_viewers(monkeypatch)

        class FirstViewer(StringViewer):
            type_id = "conflict-first"
            priority = 100

        class SecondViewer(StringViewer):
            type_id = "conflict-second"
            priority = 100

        declare_node_type("conflict-first", variable_viewer=FirstViewer)
        declare_node_type("conflict-second", variable_viewer=SecondViewer)
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner, "conflict-first")
        await env.workflows.save_draft(ident, json.dumps({"nodes": [
            {"id": "a", "type": "conflict-first", "config": {"key": "队列"}},
            {"id": "b", "type": "conflict-second", "config": {"key": "队列"}},
        ], "edges": []}))
        key = f"workflow:graph:{ident}:队列"
        await env.cache.set(key, "original")
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=graph_params(ident)))
        assert data["type"] == "str" and not data["editable"] and "冲突" in data["reason"]
        response = await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=graph_params(ident), json={"value": "bad"})
        assert response.status_code == 409 and await env.cache.get(key) == "original"

    async def test_modify_enforces_auth_and_real_graph_ownership(self, env: Env) -> None:
        _, admin_id = await login(env.client, ADMIN)
        token, plain_id = await register(env.client, PLAIN)
        ident = await writer_graph(env, admin_id, "cache", "开关")
        params = graph_params(ident, "开关")
        key = f"workflow:graph:{ident}:开关"
        await env.cache.set(key, "original")
        assert (await env.client.post(f"{VARIABLES_PATH}/add", params=params, json={"value": "bad"})).status_code == 401
        params["owner_id"] = plain_id
        assert (await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"value": "bad"})).status_code == 403
        await env.workflows.delete(ident)
        assert (await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params)).status_code == 403
        assert await env.cache.get(key) == "original"

    async def test_add_rejects_writing_over_another_registered_type(self, env: Env) -> None:
        """目录已被别的类型登记，接口层改写 -> 409，数据与登记都不动（接口不覆盖类型）。"""
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner)  # ds-list-append 图：viewer 是 DsListViewer
        key = f"workflow:graph:{ident}:队列"
        await env.cache.list_push_right(key, "a")
        # 目录登记被 cache 类型占住（比如另一张图用 cache 写过同名变量）
        await env.cache.hash_set(f"workflow:index:acct:{owner}", {key: "cache"})
        response = await env.client.post(
            f"{VARIABLES_PATH}/add", headers=auth(token), params=graph_params(ident), json={"item": "b"}
        )
        assert response.status_code == 409
        assert "cache" in response.json()["error"]["message"]
        assert await env.cache.list_range(key) == ["a"]  # 本体没动
        assert await env.cache.hash_get(f"workflow:index:acct:{owner}", key) == "cache"  # 目录没翻新

    async def test_dynamic_key_cache_variable_uses_registered_type(self, env: Env) -> None:
        """cache 节点 key 动态接线（config 无手填 key）反查不到来源：按目录登记类型查看与改写。

        回归：接口层 context() 不带登记类型时，这类变量会被 probe 猜成 str，保存时报
        「已被 cache 类型登记，str 类型不能覆盖」的 409 —— 现在应正常按缓存类型改写。
        """
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner, "cache", "")  # key 接线，config 不填
        key = f"workflow:graph:{ident}:884171955"
        await env.cache.set(key, "旧值")
        await index_variable(env.cache, owner, key, type_id="cache")
        params = graph_params(ident, "884171955")
        data = page_of(
            await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params)
        )
        assert data["type"] == "str" and data["type_label"] == "缓存" and data["editable"]
        response = await env.client.post(
            f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"value": "新值"}
        )
        assert response.status_code == 200
        assert await env.cache.get(key) == "新值"  # 本体改写成功
        assert await env.cache.hash_get(f"workflow:index:acct:{owner}", key) == "cache"  # 登记保持 cache

    async def test_partial_storage_failure_never_returns_success(self, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
        from tickneko.core.cache.models import CacheError

        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner)
        key = f"workflow:graph:{ident}:队列"
        await env.cache.list_push_right(key, "original")
        set_hash = env.cache.hash_set

        async def fail_counts(target: str, items: dict[str, str], ttl: float | None = None) -> int:
            if target == f"{key}:counts":
                raise CacheError("计数辅助键写入失败")
            return await set_hash(target, items, ttl=ttl)

        monkeypatch.setattr(env.cache, "hash_set", fail_counts)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app, raise_app_exceptions=False), base_url="http://test") as client:
            response = await client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=graph_params(ident), json={"items": ["new"]})
        assert response.status_code == 500 and not response.json()["success"]
        assert await env.cache.list_range(key) == ["new"]  # 非原子边界明确暴露，而非宣称回滚。

    async def test_unknown_variable_does_not_create_probe_keys(self, env: Env) -> None:
        token, owner = await login(env.client, ADMIN)
        params = {"scope": "account", "owner_id": owner, "key": "missing"}
        assert (await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params)).status_code == 404
        assert (await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"item": "x"})).status_code == 404
        assert await env.cache.keys("workflow:*") == []

    @pytest.mark.parametrize("body", [{}, {"field": "x"}, {"value": "x"}, {"fields": None}, {"fields": []}, {"field": "x", "value": 0, "fields": {}}, {"fields": {"valid": "x", "invalid": []}}, {"fields": {}, "unknown": False}])
    async def test_dict_errors_are_422_before_overwrite(self, env: Env, body: dict[str, object]) -> None:
        token, owner = await login(env.client, ADMIN)
        params = {"scope": "account", "owner_id": owner, "key": "配置"}
        key = f"workflow:acct:{owner}:配置"
        await env.cache.hash_set(key, {"original": "x"})
        response = await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json=body)
        assert response.status_code == 422
        assert await env.cache.hash_get_all(key) == {"original": "x"}

    async def test_body_expiring_during_discovery_does_not_fail_page(self, env: Env) -> None:
        token, owner = await login(env.client, ADMIN)
        # 目录里还有登记、本体却已经过期/被外部清掉：枚举时按「没找到」处理，不 500。
        key = f"workflow:acct:{owner}:expired"
        await env.cache.set(key, "x")
        await index_variable(env.cache, owner, key)
        await env.cache.delete(key)
        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(token)))
        assert page["items"] == []

    async def test_published_source_takes_precedence_over_new_draft(self, env: Env) -> None:
        from tickneko.workflow import canonical_graph_json, graph_checksum

        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner, "cache", "开关")
        record = await env.workflows.get(ident)
        graph = {"nodes": [{"id": "writer", "type": "cache", "config": {"key": "开关", "action": "set"}}], "edges": []}
        version, _ = await env.workflows.add_version(record, graph_json=canonical_graph_json(graph), checksum=graph_checksum(graph))
        await env.workflows.publish(ident, version.version)
        await env.workflows.save_draft(ident, json.dumps({"nodes": [{"id": "writer", "type": "ds-list-append", "config": {"key": "开关"}}], "edges": []}))
        key = f"workflow:graph:{ident}:开关"
        await env.cache.set(key, "false")
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=graph_params(ident, "开关")))
        assert data["type"] == "str" and data["data"] == "false" and data["editable"]

    async def test_declared_storage_mismatch_does_not_bypass_viewer(self, env: Env) -> None:
        token, owner = await login(env.client, ADMIN)
        ident = await writer_graph(env, owner, "cache", "开关")
        await env.cache.hash_set(f"workflow:graph:{ident}:开关", {"field": "value"})
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=graph_params(ident, "开关")))
        assert data["type"] is None and not data["editable"]

    async def test_name_rule_can_identify_account_list_without_counts(self, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
        from tickneko.workflow.nodes import VariableRule

        monkeypatch.setattr(registry, "_SPECS", dict(registry._SPECS))
        isolate_viewers(monkeypatch)

        class NamedListViewer(DsListViewer):
            type_id = "named-list"
            priority = 200
            rules = (VariableRule(name_pattern="recognized-list"),)

        declare_node_type("named-list-writer", variable_viewer=NamedListViewer)
        token, owner = await login(env.client, ADMIN)
        key = f"workflow:acct:{owner}:recognized-list"
        await env.cache.list_push_right(key, "a", "a")
        params = {"scope": "account", "owner_id": owner, "key": "recognized-list"}
        data = page_of(await env.client.get(f"{VARIABLES_PATH}/value", headers=auth(token), params=params))
        assert data["editable"] and not await env.cache.exists(f"{key}:counts")
        page_of(await env.client.post(f"{VARIABLES_PATH}/add", headers=auth(token), params=params, json={"item": "b"}))
        assert await env.cache.hash_get_all(f"{key}:counts") == {"a": "2", "b": "1"}


class TestVariableDeletion:
    async def test_account_delete_removes_family_keys(self, env: Env) -> None:
        """账号级变量删除：本体与 :counts / :meta 辅助键一并清掉，列表里不再出现。"""
        token, owner = await login(env.client, ADMIN)
        key = f"workflow:acct:{owner}:队列"
        await env.cache.list_push_right(key, "a", "a", "b")
        await env.cache.hash_set(f"{key}:counts", {"a": "2", "b": "1"})
        await env.cache.hash_set(f"{key}:meta", {"read_only": "false"})
        await index_variable(env.cache, owner, key, type_id="ds-list")

        response = await env.client.delete(
            VARIABLES_PATH,
            headers=auth(token),
            params={"scope": "account", "owner_id": owner, "key": "队列"},
        )
        assert response.status_code == 200
        assert response.json()["data"] == {"deleted": True}
        assert await env.cache.keys("workflow:*") == []
        assert page_of(await env.client.get(VARIABLES_PATH, headers=auth(token)))["total"] == 0

    async def test_delete_enforces_auth_and_ownership(self, env: Env) -> None:
        """删除的权限口径与修改一致：没登录 401，普通用户删别人名下的图变量 403。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        plain_token, _ = await register(env.client, PLAIN)
        ident = await writer_graph(env, admin_id, "cache", "开关")
        params = graph_params(ident, "开关")
        key = f"workflow:graph:{ident}:开关"
        await env.cache.set(key, "original")

        assert (
            await env.client.delete(VARIABLES_PATH, params=params)
        ).status_code == 401
        assert (
            await env.client.delete(VARIABLES_PATH, headers=auth(plain_token), params=params)
        ).status_code == 403
        assert await env.cache.get(key) == "original"

        response = await env.client.delete(
            VARIABLES_PATH, headers=auth(admin_token), params=params
        )
        assert response.status_code == 200
        assert await env.cache.get(key) is None

    async def test_delete_orphan_graph_variable_admin_only(self, env: Env) -> None:
        """图被删后留下的孤儿变量：普通用户删不了（403），管理员能删。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        plain_token, _ = await register(env.client, PLAIN)
        graph = await env.workflows.create(admin_id, "图一")
        key = f"workflow:graph:{graph.id}:计数"
        await env.cache.set(key, "1")
        await env.workflows.delete(graph.id)

        params = {"scope": "graph", "workflow_id": graph.id, "key": "计数"}
        assert (
            await env.client.delete(VARIABLES_PATH, headers=auth(plain_token), params=params)
        ).status_code == 403
        response = await env.client.delete(
            VARIABLES_PATH, headers=auth(admin_token), params=params
        )
        assert response.status_code == 200
        assert await env.cache.get(key) is None

    async def test_delete_unknown_variable_is_404(self, env: Env) -> None:
        """本体不存在：404，且不创建任何键（删除不该有探测副作用）。"""
        token, owner = await login(env.client, ADMIN)
        response = await env.client.delete(
            VARIABLES_PATH,
            headers=auth(token),
            params={"scope": "account", "owner_id": owner, "key": "missing"},
        )
        assert response.status_code == 404
        assert await env.cache.keys("workflow:*") == []


class TestVariableCreation:
    """手工新建变量：类型清单、按类型登记（本体为空）、冲突与越权。"""

    async def test_type_catalog_lists_types_nodes_actually_maintain(self, env: Env) -> None:
        """可新建的类型 = **有节点在维护**且能改写的那些：基础类型一个都不该出现。

        基础查看器（文本 / JSON / 列表 / 字典）只是兜底与基类，现行节点里没有任何一个会写
        它们 —— 建出来没人写、没人读，还占住变量名（同名节点写入会被类型守卫挡下）。
        """
        token, _ = await login(env.client, ADMIN)
        assert (await env.client.get(f"{VARIABLES_PATH}/types")).status_code == 401
        rows = await type_catalog(env, token)
        # 三类节点各自的变量类型都在（展示类型照节点注册的给）
        assert rows["cache"] == {"type_id": "cache", "label": "缓存", "view_type": "str"}
        assert rows["ds-dict"]["view_type"] == "dict"
        assert rows["ds-list"] == {
            "type_id": "ds-list",
            "label": "列表·计数",
            "view_type": "list",
        }
        # 没有节点在用的一律不列：没有「文本 / JSON / 字典」节点，通用 list 还只读
        assert set(rows) == {"cache", "ds-dict", "ds-list"}

    async def test_declared_type_joins_catalog_only_once_a_node_implements_it(
        self, env: Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """判据是「有节点在维护」而不是一份写死的名单：先声明后实现，类型自己进清单。"""
        monkeypatch.setattr(registry, "_SPECS", dict(registry._SPECS))
        isolate_viewers(monkeypatch)

        class DraftViewer(DsListViewer):
            type_id = "draft-list"
            label = "草稿列表"

        async def noop(node: object, ctx: object) -> dict[str, object]:
            return {}  # 执行器内容无关紧要：带上它注册就算「有节点在维护」

        token, _ = await login(env.client, ADMIN)
        declare_node_type("draft-writer", variable_viewer=DraftViewer)
        assert "draft-list" not in await type_catalog(env, token)  # 只有声明、没有实现

        register_executor("draft-writer", noop, variable_viewer=DraftViewer)
        assert (await type_catalog(env, token))["draft-list"]["label"] == "草稿列表"
        assert (
            await env.client.post(
                VARIABLES_PATH,
                headers=auth(token),
                params={"scope": "account", "key": "草稿", "type_id": "draft-list"},
            )
        ).status_code == 200

    async def test_create_registers_type_and_stays_editable(self, env: Env) -> None:
        """新建 = 只登记类型、本体先空着：列表列得出来，空值也能看能编辑。"""
        token, owner = await login(env.client, ADMIN)
        created = page_of(
            await env.client.post(
                VARIABLES_PATH,
                headers=auth(token),
                params={"scope": "account", "key": "设置", "type_id": "ds-dict"},
            )
        )
        assert created["type"] == "dict" and created["type_label"] == "键值对"
        assert created["editable"] and created["owner_id"] == owner
        # 空变量不占本体键，但目录里已登记 —— 枚举读目录，所以列表照常列出（不是「一个都没有」）
        key = f"workflow:acct:{owner}:设置"
        assert not await env.cache.exists(key)
        assert await env.cache.hash_get(f"workflow:index:acct:{owner}", key) == "ds-dict"
        page = page_of(await env.client.get(VARIABLES_PATH, headers=auth(token)))
        assert [(row["key"], row["type"]) for row in page["items"]] == [("设置", "dict")]
        # 空值不是 404：看得见空字典，随后按登记类型写值（走既有 add）
        params = {"scope": "account", "owner_id": owner, "key": "设置"}
        assert page_of(
            await env.client.get(
                f"{VARIABLES_PATH}/value", headers=auth(token), params=params
            )
        )["data"] == {}
        saved = page_of(
            await env.client.post(
                f"{VARIABLES_PATH}/add",
                headers=auth(token),
                params=params,
                json={"fields": {"a": "1"}},
            )
        )
        assert saved["data"] == {"a": "1"}

    async def test_create_graph_variable_needs_a_real_graph(self, env: Env) -> None:
        """图级：归属来自工作流存储；图不存在不让建（不然会落进「不知道是谁」的空目录）。"""
        token, owner = await login(env.client, ADMIN)
        graph = await env.workflows.create(owner, "图一")
        created = page_of(
            await env.client.post(
                VARIABLES_PATH,
                headers=auth(token),
                params={
                    "scope": "graph",
                    "workflow_id": graph.id,
                    "key": "开关",
                    "type_id": "cache",
                },
            )
        )
        assert created["owner_id"] == owner and created["workflow_id"] == graph.id
        assert created["type"] == "str" and created["type_label"] == "缓存"

        missing = await env.client.post(
            VARIABLES_PATH,
            headers=auth(token),
            params={
                "scope": "graph",
                "workflow_id": "ghost",
                "key": "开关",
                "type_id": "cache",
            },
        )
        assert missing.status_code == 404
        assert await env.cache.hash_get("workflow:index:acct:", "workflow:graph:ghost:开关") is None

    async def test_create_duplicate_name_is_409(self, env: Env) -> None:
        """变量名即身份：已经有本体、或已被图里的节点声明，都拒绝新建，且不覆盖。"""
        token, owner = await login(env.client, ADMIN)
        key = f"workflow:acct:{owner}:计数"
        await env.cache.set(key, "1")
        response = await env.client.post(
            VARIABLES_PATH,
            headers=auth(token),
            params={"scope": "account", "key": "计数", "type_id": "ds-dict"},
        )
        assert response.status_code == 409
        assert await env.cache.get(key) == "1"  # 本体没被动过

        # 名字已被图里的 cache 节点声明（本体还没写）：也不给建，别跟节点抢名字
        ident = await writer_graph(env, owner, "cache", "开关")
        declared = await env.client.post(
            VARIABLES_PATH,
            headers=auth(token),
            params={
                "scope": "graph",
                "workflow_id": ident,
                "key": "开关",
                "type_id": "cache",
            },
        )
        assert declared.status_code == 409
        assert await env.cache.keys("workflow:*") == [key]  # 失败的尝试没留下登记

    @pytest.mark.parametrize("type_id", ["str", "json", "dict", "list"])
    async def test_create_rejects_types_without_a_node(self, env: Env, type_id: str) -> None:
        """基础类型不给建 -> 409（没有节点会写它们），且不落残留；没注册的 id -> 422。"""
        token, _ = await login(env.client, ADMIN)
        rejected = await env.client.post(
            VARIABLES_PATH,
            headers=auth(token),
            params={"scope": "account", "key": "计数", "type_id": type_id},
        )
        assert rejected.status_code == 409
        assert "不支持手工新建" in rejected.json()["error"]["message"]

        unknown = await env.client.post(
            VARIABLES_PATH,
            headers=auth(token),
            params={"scope": "account", "key": "计数", "type_id": "nope"},
        )
        assert unknown.status_code == 422
        assert await env.cache.keys("workflow:*") == []

    async def test_create_enforces_auth_and_ownership(self, env: Env) -> None:
        """没登录 401；普通用户不能往别人名下的图或账号里建（归属来自存储，伪造不了）。"""
        admin_token, admin_id = await login(env.client, ADMIN)
        plain_token, _ = await register(env.client, PLAIN)
        graph = await env.workflows.create(admin_id, "图一")
        graph_params: dict[str, str] = {
            "scope": "graph",
            "workflow_id": graph.id,
            "key": "计数",
            "type_id": "ds-list",
        }
        assert (await env.client.post(VARIABLES_PATH, params=graph_params)).status_code == 401
        assert (
            await env.client.post(
                VARIABLES_PATH, headers=auth(plain_token), params=graph_params
            )
        ).status_code == 403
        cross = {"scope": "account", "owner_id": admin_id, "key": "计数", "type_id": "cache"}
        assert (
            await env.client.post(VARIABLES_PATH, headers=auth(plain_token), params=cross)
        ).status_code == 403
        assert await env.cache.keys("workflow:*") == []

        response = await env.client.post(
            VARIABLES_PATH, headers=auth(admin_token), params=graph_params
        )
        assert response.status_code == 200
        assert response.json()["data"]["owner_id"] == admin_id
