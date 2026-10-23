"""文本拼接节点：把**不定数量**的段按 ``part1 -> part2 -> ...`` 接成一串，从 ``text`` 出口送下去。

config:

    parts:  段数（下拉 2 ~ 10，缺省 2）—— **这个值决定节点上有几个入口**，改了画布上的口跟着变

端口（数据沿连线走）：

    ``part1`` … ``partN``   数据入口：按序号顺序参与拼接（N = ``parts``，每段必填：接线或手填）；
    ``text``                拼接结果（出口）：**字符串**，非字符串值先文本化。

口径：

* **顺序固定**是 ``part1 -> partN``，不是「按连线先后」—— 画布上谁在哪个序号一目了然，
  调整顺序靠换口，不靠动线；
* 段端口是**按数量展开**的（注册时的 ``RepeatPorts``）：段数改了，画布上的口与校验器认的
  口是同一份（后端 :func:`~tickneko.workflow.nodes.base.input_ports` 展开，前端按目录下发的
  规则展开）；
* 值统一文本化：``None`` -> 空串，其余 ``str()``（数字 / 布尔原样变成文本）；
* 每段都是必填入口：没接线也没手填（``config.partN``）在保存时就报 ``INPUT_NOT_CONNECTED``；
* **全段都空 = 业务失败**：抛 :class:`~tickneko.workflow.nodes.base.NodeFailure`，停止向下传播
  —— 空串一路送下去，下游会当成「成功拿到了内容」继续跑（比如把空消息发出去）；
* 想要固定文案的段，接一个常量节点过来（字面量别抄进每个节点）。

小抄::

    「现在是 <时间>，该打卡了」: parts=3  part1=常量"现在是 " part2=now.now_text part3=常量"，该打卡了"
    「<账号> 你好」:            parts=2  part1=user_id part2=常量" 你好"
"""
from __future__ import annotations

from typing import Any

from ..models import ValidationIssue, WorkflowNode
from .base import (
    TRIGGER_PORT,
    ConfigField,
    NodeExecutionContext,
    NodeFailure,
    PortSpec,
    RepeatPorts,
    input_value,
    repeat_count,
)
from .registry import register_node

#: 段数的可选值（**顺序即画布下拉顺序**，同时也是上下限）
PARTS_OPTIONS: tuple[str, ...] = tuple(str(n) for n in range(2, 11))

#: 段端口的展开规则：id = ``part1`` / ``part2`` …，数量读 ``config.parts``
PARTS_RULE = RepeatPorts(
    prefix="part",
    label="第 {n} 段",
    count_field="parts",
    default_count=2,
    min_count=2,
    max_count=10,
    required=True,
)

#: 日志里展示结果时的截断长度（避免一段长文本刷屏）
CLIP_CHARS: int = 40


def _text_of(raw: Any) -> str:
    """把入口值变成文本：``None`` -> 空串，其余 ``str()``（数字 / 布尔原样文本化）。"""
    return "" if raw is None else str(raw)


def _clip(raw: str) -> str:
    """日志里展示的值：太长截断（避免一段长文本刷屏）。"""
    return raw if len(raw) <= CLIP_CHARS else raw[:CLIP_CHARS] + "…"


def validate_concat_parts(node: WorkflowNode) -> list[ValidationIssue]:
    """段数必须是枚举里的一项（下拉之外的手写值保存时就拦，运行时不猜）。"""
    raw = node.config.get(PARTS_RULE.count_field)
    if raw is None or str(raw).strip() in PARTS_OPTIONS:
        return []
    return [
        ValidationIssue(
            node_id=node.id,
            code="INVALID_CONCAT_PARTS",
            message=f"concat 节点 {node.id} 的段数 {raw!r} 不合法",
            suggestion=f"可选：{' / '.join(PARTS_OPTIONS)}",
        )
    ]


@register_node(
    "concat",
    label="文本拼接",
    color="#10b981",
    order=135,
    category="data",
    # 段端口不在这里写：它们按 config.parts 展开（见 PARTS_RULE + input_ports）
    inputs=[TRIGGER_PORT],
    outputs=[
        TRIGGER_PORT,
        PortSpec("text", "message", "拼接结果"),
    ],
    repeat_inputs=PARTS_RULE,
    fields=[
        ConfigField(PARTS_RULE.count_field, "段数", default="2", options=PARTS_OPTIONS),
    ],
    validator=validate_concat_parts,
)
async def exec_concat(node: WorkflowNode, ctx: NodeExecutionContext) -> dict[str, Any]:
    """按 ``part1 -> partN`` 拼成一串（N = 段数），结果从 ``text`` 送下去。"""
    count = repeat_count(node.config.get(PARTS_RULE.count_field), PARTS_RULE)
    parts = [
        _text_of(input_value(node, ctx, f"{PARTS_RULE.prefix}{index}", default=""))
        for index in range(1, count + 1)
    ]
    if not any(parts):
        # 全段都空：拼出来的必然是空串，往下送等于骗下游「拿到内容了」
        ctx.logger.warning(f"[concat:{node.id}] 没有可拼接的内容（{count} 段都空）")
        ctx.log.append(f"[concat] {node.id}: 没有可拼接的内容")
        raise NodeFailure(f"没有可拼接的内容（{count} 段都空）")

    text = "".join(parts)
    ctx.logger.info(f"[concat:{node.id}] {count} 段 -> {len(text)} 字：{_clip(text)}")
    ctx.log.append(f"[concat] {node.id}: {_clip(text)}")
    return {"text": text}
