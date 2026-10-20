# TickNeko

[![CI](https://github.com/haloneko/TickNeko/actions/workflows/ci.yml/badge.svg)](https://github.com/haloneko/TickNeko/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Python 3.12+](https://img.shields.io/badge/Python-3.12%2B-blue.svg)
![Node 20+](https://img.shields.io/badge/Node-20%2B-brightgreen.svg)

TickNeko 是一个可视化拖拽制作聊天机器人，支持多种触发方式，支持多平台与多账号隔离，通过画布连线编排工作流节点，一个 Docker 镜像即可自部署前后端。

**多种触发方式**:
- 时间触发:到时间自动运行
- 消息触发:收到消息自动运行
- 事件触发:收到某个事件运行

技术栈：后端 Python 3.12+（FastAPI / SQLModel），控制台 React + TypeScript。

![](./docs/workflow.jpg)

## 启动

```bash
python -m venv .venv && .venv\Scripts\activate     # Windows
pip install -r requirements.txt
copy config.toml.example data\config.toml          # 改成自己的配置（Linux: cp config.toml.example data/config.toml）
python app.py                                      # 后端 http://127.0.0.1:18080（读 data/config.toml，没有就按默认值跑）
cd frontend && npm install && npm run dev          # 控制台 http://127.0.0.1:15173
```

Windows 也可以直接双击 `scripts\start-all.bat`（后端 / 前端单独起分别是同目录下的
`start-backend.bat` / `start-frontend.bat`）。

数据库可选：sqlite、mariadb；

缓存可选：redis、内存

## 部署（Docker）

一个镜像里同时装前端与后端：nginx 在 80 端口托管控制台，并把 `/api`、`/docs` 反代给
同容器内的后端 —— 前端不需要跨域配置。

```bash
docker compose up -d --build              # 控制台 http://127.0.0.1:8080
```

配置不用提前准备：它跟数据一起住在 `data/` 下，容器第一次启动会照模板生成 `data/config.toml`，
在宿主上改完 `docker compose restart` 即生效（想自己写就先 `cp config.toml.example data/config.toml`）。

一键打包（前端产物 + 后端源码包 + 单镜像）：

```bat
scripts\build-all.bat              :: Windows：前端 + 后端 + tickneko:latest
scripts\build-all.bat --no-docker  :: 只打包产物，不碰 Docker
```

```bash
./scripts/build-all.sh        # Linux / macOS，参数同上
```

端口、挂载卷、容器里要改的配置（比如 `[api] host` 建议改回 `127.0.0.1`）、不用 Docker 的部署方式，
见 [docs/deploy.md](docs/deploy.md)。

## 测试

```bash
pytest
pytest -n 8   #并行测试，速度更快
```

## 前端打包

```bash
cd frontend && npm install && npm run build
```

## 本地账号

本地试用账号只有一个（由 `tickneko/api/services/user/demo.py` 写入，**部署到公网前务必改密码**）：

| 账号 | 密码 | 角色 |
|---|---|---|
| `admin` | `tickneko-admin` | 管理员 |

要别的账号不必改代码：在登录页注册（`POST /api/auth/register`）即可，新账号是普通用户。

## 现在支持什么

| 平台 | 连接方式 | 备注 |
|---|---|---|
| OneBot | 反向 WebSocket | 框架做服务端（默认 16700），实现端连进来，靠握手令牌认归属 |
| Kook | 正向 WebSocket | 框架做客户端，用 Bot Token 连网关；发消息走 REST |

内置节点：



自己写节点、写契约、写校验规则，见 [docs/workflow/workflow.md](docs/workflow/workflow.md)。

## 接下来想做的

- 更多平台：Discord、Telegram、钉钉、Slack……
- 节点市场
- 可视化调试：断点、单步、值预览
- 插件机制，节点和适配器能以独立包发布

## 想一起来？

欢迎提 Issue，也欢迎直接发 PR。

- 加平台 → 实现 `BotAdapter`，补文档。
- 加节点 → 一个文件，注册一下，框架不用动。
- 文档、bugfix、想法。

架构细节从 [docs/README.md](docs/README.md) , [examples/](examples/) 示例。

## 文档

- [docs/README.md](docs/README.md)：框架总览与文档索引（分层、依赖方向、装配链路、配置、可选依赖）
- [docs/app/app.md](docs/app/app.md)：启动顺序与停机收尾、配置怎么读 / 怎么报错（根目录 `app.py` / `config.py`）
- [docs/deploy.md](docs/deploy.md)：打包与部署（Docker 单镜像 / compose、一键打包脚本、不用 Docker 的跑法）
- [docs/workflow/workflow.md](docs/workflow/workflow.md)：工作流模块索引、写自己的节点（第 5 节）、**从画布到运行：保存版本 → 发布 → 运行开关**（第 8 节）
- 其余模块文档：[logger](docs/logger/logger.md) · [scheduler](docs/scheduler/scheduler.md) · [cache](docs/cache/cache.md) · [bridge](docs/bridge/bridge.md)
- [examples/](examples/)：可直接运行的最小示例

## 参与

- [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)：环境准备、目录速览、代码约定、测试与提交规范
- [.github/CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md)：社区行为准则
- [.github/SECURITY.md](.github/SECURITY.md)：漏洞报告渠道与部署注意事项
- [docs/THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES)：第三方组件与许可
- [`NOTICE`](NOTICE)：本项目的署名声明（分发派生作品时要一起带上）

## 许可证

[Apache License 2.0](LICENSE) © 2026 TickNeko

分发时带上 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)（保留版权与署名）
不得用 TickNeko 的名字或商标给派生作品背书。
