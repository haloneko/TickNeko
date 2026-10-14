"""清理日志的请求体。

清理是**破坏性**操作，参数只在接口层收两样：时间线（只许清三天前的）与范围（归属），
两者都有默认值，不传就是「清默认线之前、自己名下的」。
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel, ConfigDict, Field


class ClearLogsRequest(BaseModel):
    """清库日志：``before`` 之前的会被删掉，只限数据库出口、只许清三天前的。

    ``before`` 不传 = 默认三天前（只删三天前的历史）；传了则必须是**不晚于**三天前
    的时刻（三天内的日志清不掉）—— 时间线在接口层校验，不让清理请求误伤新日志。
    """

    #: 清理线：删除早于该时刻的日志（Unix 时间戳或 ISO 字符串）；不传 = 三天前
    before: str | None = Field(
        default=None, description="删除早于该时刻的日志；不传 = 默认三天前"
    )
    #: 范围：只删这个归属名下的；不传时普通用户强制 = 自己，管理员 = 全部（含公共）
    owner_id: str | None = Field(
        default=None, description="只删该归属名下的日志；不传按角色决定（自己 / 全部）"
    )

    model_config: ClassVar[ConfigDict] = ConfigDict(
        json_schema_extra={"example": {"before": None, "owner_id": None}},
    )
