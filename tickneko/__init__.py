"""TickNeko（包名 ``tickneko``）—— 机器人框架。

分层约定：

* ``tickneko.api``     接口层（对外协议、消息入口）
* ``tickneko.core``    核心层（日志、配置等基础能力）

日志的落库实现在 ``tickneko.core.logger.store``（命名同 ``workflow/store.py`` / ``bots/store.py``
的落库惯例：协议与后端都住在能力自己的包里，且平铺，不再单起一个公共数据层）。
"""

__version__ = "0.1.0"
