"""变量 HTTP 入口：鉴权、完整参数转发与错误封装；见 docs/variables/variables.md。"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Annotated, Any, TypeVar

from fastapi import APIRouter, Body, Query, Request, status

from tickneko.variables import VariableContext, VariableTypeConflict

from ...common.dependencies import trace_id_of
from ...common.errors import ApiError, ErrorCode, HttpStatus
from ...common.models import ApiResponse, ErrorResponse
from ...services.auth.models import CurrentUser
from ...services.variables import (
    VariableAlreadyExists,
    VariableNotEditable,
    VariableNotFound,
    VariableService,
    creatable_types,
)
from ..auth.dependencies import CurrentUserDep
from ..onebot.dependencies import ensure_can_touch
from ..workflow.dependencies import WorkflowStoreDep, owner_filter_of
from .dependencies import CacheDep
from .responses import (
    VariableData,
    VariablePage,
    VariableSummary,
    VariableTypeItem,
)

router = APIRouter(prefix="/variables", tags=["变量查看"])
ALL_SCOPES: tuple[str, ...] = ("graph", "account")
MAX_LIMIT = 500
_T = TypeVar("_T")

_RESPONSES = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "没登录 / 令牌无效",
    },
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": "不能操作别人的变量",
    },
    status.HTTP_404_NOT_FOUND: {"model": ErrorResponse, "description": "变量不存在"},
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": "查看器不允许修改 / 类型冲突 / 同名变量已存在",
    },
    HttpStatus.UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "变量身份或查看器参数错误",
    },
    status.HTTP_503_SERVICE_UNAVAILABLE: {
        "model": ErrorResponse,
        "description": "缓存未接入",
    },
}


async def _call(operation: Awaitable[_T]) -> _T:
    """统一调用边界；存储故障保持原来的异常处理，不伪装成参数错误。"""
    try:
        return await operation
    except ValueError as exc:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            str(exc),
            status_code=HttpStatus.UNPROCESSABLE_ENTITY,
        ) from exc
    except VariableNotFound as exc:
        raise ApiError(
            ErrorCode.HTTP_ERROR, str(exc), status_code=status.HTTP_404_NOT_FOUND
        ) from exc
    except VariableNotEditable as exc:
        raise ApiError(
            ErrorCode.HTTP_ERROR, str(exc), status_code=status.HTTP_409_CONFLICT
        ) from exc
    except VariableAlreadyExists as exc:
        # 变量名即身份：同名的新建请求不能覆盖已有变量，换名字或先删除。
        raise ApiError(
            ErrorCode.HTTP_ERROR, str(exc), status_code=status.HTTP_409_CONFLICT
        ) from exc
    except VariableTypeConflict as exc:
        # 与运行时同一套守卫：写前拦截的「类型冲突」走同一个 409，文案也归一
        raise ApiError(
            ErrorCode.HTTP_ERROR, str(exc), status_code=status.HTTP_409_CONFLICT
        ) from exc


async def _context(
    service: VariableService,
    user: CurrentUser,
    *,
    scope: str,
    key: str,
    owner_id: str | None,
    workflow_id: str,
) -> VariableContext:
    if owner_id is not None:
        ensure_can_touch(user, owner_id)
    context = await _call(
        service.context(
            scope=scope,
            key=key,
            owner_id=user.user.id if owner_id is None else owner_id,
            workflow_id=workflow_id,
        )
    )
    # 图归属来自真实存储；调用方不能通过 owner_id 给孤儿图伪造归属。
    ensure_can_touch(user, context.owner_id)
    return context


@router.get(
    "",
    response_model=ApiResponse[VariablePage],
    summary="列出变量（只含元数据）",
    responses=_RESPONSES,
)
async def list_variables(
    request: Request,
    user: CurrentUserDep,
    cache: CacheDep,
    store: WorkflowStoreDep,
    owner_id: str | None = None,
    scope: Annotated[str | None, Query(description="graph / account")] = None,
    query: Annotated[str | None, Query(description="变量名模糊匹配")] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ApiResponse[VariablePage]:
    if scope is not None and scope not in ALL_SCOPES:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "作用域要 graph/account 之一",
            status_code=HttpStatus.UNPROCESSABLE_ENTITY,
        )
    if owner_id is not None:
        ensure_can_touch(user, owner_id)
    service = VariableService(cache, store)
    snapshots, total = await _call(
        service.page(
            scope=scope,
            keyword=(query or "").strip(),
            owner=owner_filter_of(user, owner_id),
            limit=limit,
            offset=offset,
        )
    )
    items = [VariableSummary.from_snapshot(snapshot) for snapshot in snapshots]
    return ApiResponse[VariablePage](
        data=VariablePage(items=items, total=total), trace_id=trace_id_of(request)
    )


@router.get(
    "/types",
    response_model=ApiResponse[list[VariableTypeItem]],
    summary="可新建的变量类型清单",
    responses=_RESPONSES,
)
async def list_variable_types(
    request: Request,
    user: CurrentUserDep,
) -> ApiResponse[list[VariableTypeItem]]:
    """新建变量时能选的类型：注册表里**能直接编辑**的那些（不碰缓存，也不碰任何人的数据）。"""
    return ApiResponse[list[VariableTypeItem]](
        data=[
            VariableTypeItem(
                type_id=item.type_id, label=item.label, view_type=item.view_type
            )
            for item in creatable_types()
        ],
        trace_id=trace_id_of(request),
    )


@router.post(
    "",
    response_model=ApiResponse[VariableData],
    summary="新建变量（登记类型，本体为空）",
    responses=_RESPONSES,
)
async def create_variable(
    request: Request,
    user: CurrentUserDep,
    cache: CacheDep,
    store: WorkflowStoreDep,
    scope: str,
    key: str,
    type_id: str,
    owner_id: str | None = None,
    workflow_id: str = "",
) -> ApiResponse[VariableData]:
    """按 ``type_id`` 新建一个逻辑变量：只登记类型，本体先空着，随后照常查看 / 编辑。

    定位口径与其余接口一致（图级传 ``scope=graph&workflow_id=…&key=…``；账号级传
    ``scope=account&key=…``，省略归属取当前用户）。同名变量只能有一个：已存在（有本体、
    已登记类型，或已被图里的节点声明）返回 409，不覆盖。
    """
    service = VariableService(cache, store)
    context = await _context(
        service,
        user,
        scope=scope,
        key=key,
        owner_id=owner_id,
        workflow_id=workflow_id,
    )
    snapshot = await _call(service.create(context, type_id))
    return ApiResponse[VariableData](
        data=VariableData.from_snapshot(snapshot), trace_id=trace_id_of(request)
    )


@router.get(
    "/value",
    response_model=ApiResponse[VariableData],
    summary="查看变量",
    responses=_RESPONSES,
)
async def view_variable(
    request: Request,
    user: CurrentUserDep,
    cache: CacheDep,
    store: WorkflowStoreDep,
    scope: str,
    key: str,
    owner_id: str | None = None,
    workflow_id: str = "",
) -> ApiResponse[VariableData]:
    service = VariableService(cache, store)
    context = await _context(
        service,
        user,
        scope=scope,
        key=key,
        owner_id=owner_id,
        workflow_id=workflow_id,
    )
    snapshot = await _call(service.view(context))
    return ApiResponse[VariableData](
        data=VariableData.from_snapshot(snapshot), trace_id=trace_id_of(request)
    )


@router.post(
    "/add",
    response_model=ApiResponse[VariableData],
    summary="保存变量（整份交给查看器）",
    responses=_RESPONSES,
)
async def add_variable(
    request: Request,
    user: CurrentUserDep,
    cache: CacheDep,
    store: WorkflowStoreDep,
    params: Annotated[dict[str, Any], Body()],
    scope: str,
    key: str,
    owner_id: str | None = None,
    workflow_id: str = "",
) -> ApiResponse[VariableData]:
    service = VariableService(cache, store)
    context = await _context(
        service,
        user,
        scope=scope,
        key=key,
        owner_id=owner_id,
        workflow_id=workflow_id,
    )
    snapshot = await _call(service.add(context, params))
    return ApiResponse[VariableData](
        data=VariableData.from_snapshot(snapshot), trace_id=trace_id_of(request)
    )


@router.delete(
    "",
    response_model=ApiResponse[dict[str, bool]],
    summary="删除变量",
    responses=_RESPONSES,
)
async def delete_variable(
    request: Request,
    user: CurrentUserDep,
    cache: CacheDep,
    store: WorkflowStoreDep,
    scope: str,
    key: str,
    owner_id: str | None = None,
    workflow_id: str = "",
) -> ApiResponse[dict[str, bool]]:
    service = VariableService(cache, store)
    context = await _context(
        service,
        user,
        scope=scope,
        key=key,
        owner_id=owner_id,
        workflow_id=workflow_id,
    )
    await _call(service.delete(context))
    return ApiResponse[dict[str, bool]](
        data={"deleted": True}, trace_id=trace_id_of(request)
    )
