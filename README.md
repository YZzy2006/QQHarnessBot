# QQHarnessBot

基于 **DeepSeek Harness** 的 QQ AI 伙伴，支持角色卡、会话记忆、主动互动和日常工具。
项目主要面向中文 QQ 使用场景，提供本地网页控制台和按会话隔离的工具权限。

本项目基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 扩展，保留上游 MIT 许可证与署名。
主要扩展包括管理员便捷指令、陪伴工具、连续天气与地点追问、地图位置卡片及私有周记隔离。
详细来源和第三方许可见 [NOTICE.md](NOTICE.md)。

## 能做什么

- **聊天与角色**：群聊和私聊分别维护会话，支持 Markdown 角色卡与正常唤醒时的角色版本刷新。
- **互动控制**：白名单、暂停、静默、发送限额、手动唤醒和忙时请求排队。
- **记忆与陪伴**：共同回忆、纪念日、专注计时和时光胶囊；真实运行数据只保存在本机。
- **天气与地图**：连续天气追问；高德、腾讯、天地图、百度按可用性兜底查询，支持 QQ 位置卡片。
- **管理工具**：任务、便签、消息搜索、群摘要、群知识、截图待办、文件对比、报错档案与公告草稿确认。
- **可选能力**：公开搜索、兴趣简报、语音识别、图片理解、语音合成与图片生成，需自行配置相应服务。
- **中文控制台**：查看会话、工具权限、角色、唤醒策略和用量记录。

```text
QQ ↔ 自行运行的 SnowLuma / OneBot v11 ↔ QQHarnessBot ↔ DeepSeek Harness ↔ 模型服务
                                         ↕
                               本地控制台与本机状态文件
```

## 运行前准备

1. **Node.js 22.13 或更新版本**，以及 Git。
2. 自行安装、启动并登录 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，启用 Web 服务。
3. 自行安装、启动并登录 SnowLuma，配置 OneBot v11 WebSocket 与 HTTP API。
4. 你有权使用的 QQ 账号、模型服务以及需要启用的第三方 API。

本项目不捆绑 SnowLuma、QQ 客户端、原生组件、登录态或模型凭据。
DSH 接入使用 Cookie 鉴权、斜杠 RPC 和事件流；接口变动可能需要适配。
当前适配来源为 DSH 0.2.0-rc.2 代际；不能据此保证任意未来版本兼容。

## 快速开始

### 1. 下载并安装

```bash
git clone https://github.com/YZzy2006/QQHarnessBot.git
cd QQHarnessBot
npm ci
```

安装时的 `postinstall` 仅修补本机 `@snowluma/sdk` 安装副本的 ESM 相对导入扩展名。
不会安装、启动或修改 SnowLuma 本体。SheetJS 从其官方 CDN 固定版本安装，需能够访问该站点。

### 2. 创建本机配置

PowerShell：

```powershell
Copy-Item config.example.json config.json
Copy-Item .env.example .env
```

Linux / macOS：

```bash
cp config.example.json config.json
cp .env.example .env
chmod 600 config.json .env
```

编辑 `config.json` 中这些字段：

| 字段 | 用途 |
| --- | --- |
| `ownerQQ` | 管理员 QQ 号，必须填写你自己的账号 |
| `allow.private` / `allow.groups` | 允许接入的私聊 QQ 和群号，先只放测试会话 |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | 选择你自己的 DSH 实际支持的模型与档位 |
| `snowluma.wsUrl` / `snowluma.httpUrl` | OneBot 地址，默认分别为本机 3001 / 3000 端口 |
| `snowluma.accessToken` | OneBot 访问令牌；只填进本机配置 |
| `snowluma.followDiscoveredEndpoint` | 是否跟随自动发现的端点；多实例部署建议关闭并明确填写地址 |
| `consoleToken` | 本地控制台令牌；留空时由程序生成 |

`dsh.authToken` 通常留空，桥接通过你自己的 DSH 本机凭据获取会话 Cookie。
示例配置默认不放行空白名单、不自动加入新好友、不启用黑话外部研究和普通主动问候。
请先确认白名单、使用范围和费用，再在控制台逐项开启需要的功能。

### 3. 安装 DSH 端预设

```bash
npm run setup:dsh
```

该步骤会在你自己的 DSH `web` profile 中注册 `qq-chat` / `qq-chat-v2` 预设及 MCP 工具，
并对相关文件做时间戳备份。可用 `DSH_HOME` 指定 DSH 目录；其他 profile 可运行
`node --env-file-if-exists=.env scripts/setup-dsh.mjs <profile>`。
操作会修改 DSH 配置，执行前请确认目标 profile，然后重启 DSH。

### 4. 启动桥接

```bash
npm start
```

打开 `http://127.0.0.1:3100`，用启动时提示或本机配置中的控制台令牌登录。
先选择通用示例角色、确认模式和白名单，再从自己的 QQ 发送测试消息。
`closed-agent` 会给予管理员更强的本机工具能力，启用前请理解其权限范围。

## 可选服务与密钥

所有密钥自行申请，`.env.example` 中的值均为空。`npm start` 会读取本机 `.env`，
但 DSH 启动的 MCP 子进程未必继承桥接环境；检索服务可按下表使用受保护的本机密钥文件。

| 能力 | 环境变量 / 本机配置 |
| --- | --- |
| 和风天气 | `HEFENG_WEATHER_API_KEY` 与账号对应的 `HEFENG_WEATHER_API_HOST` |
| 高德地图 | `GAODE_WEB_API_KEY` |
| 腾讯地图 | `TENGXUNDITU_API_KEY` |
| 天地图 | `TIANDITU_API_KEY` |
| 百度地图 | `BAIDUDITU_API_KEY` |
| 博查搜索 | `BOCHA_API_KEY`，或本机 `state/.bocha-key` |
| DeepSeek 检索 | `DEEPSEEK_API_KEY`，或本机 `state/.deepseek-key` |
| 元宝搜索兜底 | `YUANBAO_SEARCH_API_KEY`，或本机 `state/.yuanbao-search-key` |
| 图片理解、语音与通义图片 | `QWEN_API_KEY` / `BAILIAN_API_KEY` / `DASHSCOPE_API_KEY`，按功能支持范围填写 |
| 豆包图片 | `DOUBAO_API_KEY` |

没有配置某项密钥时，相应可选功能不可用或按已有规则兜底，不代表聊天模型需要换成其他供应商。
Linux 上的密钥文件应仅当前运行用户可读；不要在群聊、Issue、截图或命令行参数中粘贴密钥。

## 中文使用说明

- [管理员便捷指令](docs/OWNER-TOOLS-USAGE.md)
- [天气、地点与陪伴功能](docs/COMPANION-USAGE.md)
- [个人设置、群知识和扩展工具](docs/UTILITIES-USAGE.md)
- [连续追问、排队与地图发送边界](docs/REQUEST-CONTINUITY.md)
- [隐私、安全与数据流](SECURITY.md)
- [贡献与安全发布流程](CONTRIBUTING.md)

例如，可发送 `[天气查询][广州][明天]`、`[找店][广州][咖啡店]`。
地点查询后，本会话本人可继续说“换腾讯的”“选第二个”“发这个”。
普通查询保持只读；明确要卡片时才提交。腾讯 `121` 表示该次请求遇到日额度耗尽，
工具可以改用其他健康来源；必须按实际 `source` / `fallback` 说明来源。
QQ 接口提交成功不保证所有客户端都能正确显示或点击，仍需实际验收。

## 测试与发布检查

```bash
npm test
npm run check:release
npm run hooks:install
```

`npm test` 使用临时目录、假 QQ / DSH / 供应商响应，不需要生产密钥。
自动化验证不能替代真实模型质量、供应商账号权限或 QQ 客户端显示验收。
发布检查覆盖明确文件清单、危险文件名、密钥特征及暂存区 / 历史内容；
CI 另运行 Gitleaks。任何扫描都有边界，不能替代对新增功能和数据的审查。

本项目用独立发布目录创建新的 Git 历史，没有携带维护者原运行仓库的历史、真实配置、
私人角色卡、聊天记录、管理员周记、备份或登录二维码。

## 隐私与使用边界

QQ 消息可能经 DSH 发往你选择的模型服务；公开搜索会把查询词发给检索服务，
地图、天气、语音、图像功能也会把对应输入发往各自供应商。请先告知相关参与者。
管理员私有周记走独立生成与投递链，受管正文路径阻止进入聊天、引用和长期记忆；
用户自行改写、重新拍照或第三方转述的内容无法保证自动识别。

平台账号限制、供应商额度、权限和计费由各平台决定。请在获得授权的会话中使用，
勿用于骚扰、批量滥发或未经同意收集他人资料。

## 许可证与致谢

桥接代码沿用 [MIT](LICENSE)，保留上游作者署名；本项目新增贡献归各贡献者所有。
感谢 qq-bridge、DeepSeek Harness 及其贡献者。
第三方依赖、SnowLuma 及其原生组件按各自许可使用，详见 [NOTICE.md](NOTICE.md)。
