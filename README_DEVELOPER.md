# 🛠️ 开发者部署手册

[项目首页](README.md) · [配置地图](docs/CONFIGURATION.md) · [AI 执行手册](README_AI.md)

## 1 · 先理解进程关系

```text
QQ / SnowLuma（你自行部署） ←→ QQHarnessBot:3100 ←→ DSH:3080 ←→ 你配置的模型
                                      ↑
                         BotWork:3188（可选轻量API网关）
                                      ↑
                        HTTPS / Nginx + 工作台静态页面
```

机器人只有一份。工作台网关不能替代 DSH，也不应再启动第二份机器人。`3100` 和 `3188` 都留在回环地址；公网只开放你配置好的 HTTPS 站点。

## 2 · 安装机器人

需要 Node.js ≥22.13、Git，以及你自己已启动的 SnowLuma / OneBot v11 和 DSH。视频/音轨/部分语音功能还需要 ffmpeg、ffprobe；供应商密钥按需配置。

```bash
git clone https://github.com/YZzy2006/QQHarnessBot.git
cd QQHarnessBot
npm ci
cp config.example.json config.json
cp .env.example .env
chmod 600 config.json .env
```

PowerShell 将 `cp` 换成 `Copy-Item`，不要照搬 `chmod`；使用 Windows ACL 限制真实配置的读取者。

编辑 `config.json`：填写自己的 `ownerQQ` 和测试会话白名单、OneBot 地址/令牌、DSH 供应商/模型。不要把示例 ID 当作维护者真实账号。二代模式由控制台/工作台模式开关配置；预设的选择必须与当前模式对应。

```bash
npm run setup:dsh
# 确认目标 DSH profile；仅在安装/预设变化确实需要时重启自己的DSH
npm start
```

`setup:dsh` 注册预设和受限 MCP，会备份目标文件；`DSH_HOME` 可指定自己的 DSH 目录，其他 profile 用 `node --env-file-if-exists=.env scripts/setup-dsh.mjs <profile>`。不要把本机 DSH profile、token 或 `.dsh` 一起提交。

确认控制台可访问、DSH就绪、QQ在线、测试会话可用。真实QQ投递和供应商测试会产生动作/费用，不属于离线测试。

## 3 · 模型与可选服务

完整配置入口见 [配置地图](docs/CONFIGURATION.md)。常见区别：

- **聊天换模型**：先在DSH配置供应商，再改 `dsh.provider/model/reasoningEffort`；不能仅修改 `vision.model`。
- **天气/定位**：和风专属Host与Key、多地图服务端Key；它们不是聊天模型插件。
- **语音**：百炼密钥、`socialV2.voice.ttsModel/ttsVoice` 和会话声线；ASR模型当前写在适配器中，不存在通用切换下拉框。
- **图片/视频**：独立视觉/生成模型与读取工具；登录态和缓存只能在本机建立。
- **可选依赖**：没有配置该服务时，应显示不可用；不要为了让健康检查变绿而填假密钥。

## 4 · 启用工作台

界面与网关单独发布在 [QQHarnessWorkbench](https://github.com/YZzy2006/QQHarnessWorkbench)。机器人仓库保留实际业务适配与匹配版本的工作台模块；另仓提供完整界面、Node网关、后端模块参考与部署模板。

1. 将本机 `config.json` 的 `workbench.origin` 设为自己的完整 HTTPS Origin。
2. 初始化本机工作台账号。密码从终端安全读取，经管道交给CLI，不进命令参数、Git或shell历史：

```bash
python3 scripts/init-workbench-account.py
```

入口交互读取用户名和密码，并通过stdin调用同目录的`workbench-account.mjs`。不将密码放在argv、shell历史或公开配置中。

3. 按工作台仓库教程启动 `BotWork:3188`，由Nginx服务静态页面，并将 `/api/workbench/` 转发到网关，保留 Cookie/Origin。不要给公网反代旧控制台的全权 `/api/`。
4. 从同源HTTPS站点登录；未登录 `/api/workbench/session` 应返回401；`/healthz` 是本机网关探活，不能代替登录/权限/实际业务验收。

最小部署使用本地scrypt账号，不依赖维护者的博客。若要复用自己的独立MySQL账号库，见 [数据库认证](docs/WORKBENCH-AUTH.md)。头像OSS是可选独立存储适配；未配置不阻断其他页面。

## 5 · 部署为服务与升级

仓库 [deploy](deploy/) 只提供示例，路径与运行用户按你机器调整。不要把维护者的IP、用户名、私钥或生产配置复制成模板。

- 升级前备份本机配置、人物卡、任务和状态；私有备份放在仓库外，权限收紧。
- 先在隔离目录 `npm ci` 和定向测试，再对比版本与文件清单；不覆盖 `state/`、`.env` 或你的人物卡。
- 修改真实机器人代码时，确认DSH没有在途业务回合再受控重启桥接；不因网页更新重启QQ、DSH、数据库或重建SnowLuma。
- 只改静态页面不需要重启机器人。更新HTML资源版本，避免缓存继续加载旧JS/CSS。
- 代码回滚只恢复上一版代码，不无条件恢复旧状态。不要运行旧的一次性发送/迁移/清理脚本。

## 6 · 验证与开发

```bash
npm test
npm run test:faces
npm run test:video
npm run test:workbench
npm run check:release
npm run check:history
```

这些测试使用临时目录/假接口。`npm test` 是仓库选择的基础回归，不代表穷举所有可选服务；专题测试和具体结果见 [本次发布说明](docs/RELEASE-2026-11-08.md)。真实账号、模型质量、QQ客户端显示与外部平台风控需要你在有授权的测试会话单独确认。

提交前按 `release-files.json` 明确清单暂存，执行 `node scripts/stage-release.mjs`。禁止将真实state、私人人物卡、日志、二维码、头像上传、`.env` 和凭据文件加到清单。仓库的字体二进制仅允许经过OFL许可审核、固定路径与SHA256匹配的单个子集；不泛化放行其他二进制。


## 逐步验收与失败定位

| 检查点 | 命令/动作 | 预期结果 | 不符时先检查 |
| --- | --- | --- | --- |
| Node版本 | `node --version` | ≥22.13 | 使用服务实际Node路径，不只看交互终端 |
| 安装完整 | `npm ci` | 按锁文件安装成功 | 网络/registry/原生依赖，不手改lock绕过失败 |
| DSH可独立工作 | 用自己的DSH完成测试 | 模型与工具目录正常 | provider/model是否真实存在、凭据与上游兼容性 |
| QQ网关 | 查已有网关在线状态 | 自己的账号在线，OneBot地址可达 | 登录态、端口、令牌；不要反复重建容器 |
| 机器人 | `npm start`查看脱敏状态 | DSH就绪、QQ在线、控制台启动 | 本机配置、白名单和进程环境 |
| 账号初始化 | `python3 scripts/init-workbench-account.py`（机器人目录） | 只保存加盐哈希，密码不出现在命令行 | Python/Node可执行路径和state目录写权限 |
| 网关探活 | `curl --fail http://127.0.0.1:3188/healthz` | `ok:true`、`backend:ready` | 机器人3100是否就绪，端口/Host是否正确 |
| 未登录保护 | `curl -i https://workbench.example.com/api/workbench/session` | HTTP401 | Nginx是否错反代旧控制台或命中缓存 |
| 静态界面 | 从自己的HTTPS域名打开 | 页面/JS/CSS/本地字体正常 | root是否指向public、资源路径、证书与HTML版本 |
| 登录失败 | 用自己初始化的工作台账号登录 | Cookie登录会话建立 | 独立账号不是QQ/DSH账号；数据库模式是否已明确启用 |
| 写操作403 | 读取会话后按界面操作 | 合法Origin、Cookie、CSRF | `workbench.origin`协议/域名/端口、反代Host与浏览器同源 |
| 退出/改密 | 退出或修改自己的密码 | 原会话失效，需重登 | 是否缓存接口或混用了其他项目Cookie |
| 天气/定位 | 授权测试会话发一次查询 | 有实际来源，缺配置给明确错误 | 专属天气Host、地图服务端Key、供应商权限 |
| 语音/视频 | 在授权会话测试实际媒体 | 成功处理或明确缺失项 | ffmpeg/ffprobe、模型权限、格式、额度与超时 |

`example.com`须替换为自己的域名。上述模型/QQ/媒体动作会产生真实费用或投递，只有获得授权才执行。先通过离线测试和匿名保护检查，不用真实用户聊天作测试数据。

### 数据备份与升级清单

升级前只在本机私有位置备份`config.json`、`.env`、`state/`和自己的人物卡；数据库用户、OSS配置、聊天/日记、上传图片及B站登录态都不入库。逐层识别本次是前端、网关还是机器人改动。不要为了发布源码重新登录QQ、清空记忆或将测试state迁移生产。

### 给AI的完成判据

必须报告“检查了什么、得到什么、没做什么”，分别记录离线回归、匿名401、登录/CSRF、实际QQ投递与供应商测试。无法访问真实账号时明确未验收；不能用接口成功补写“客户端可见”，也不能为了凑通过率跳过失败用例、打印凭据或静默改权限。


### 服务名与部署路径

服务器状态页默认查询`qq-bridge.service`与`dsh-web.service`。机器人服务示例应安装为`qq-bridge.service`，或按你的实际服务名调整状态适配器；服务未知不代表QQ账号已离线。示例路径`/opt/QQHarnessBot`、`/opt/QQHarnessWorkbench`及运行用户都是部署占位，先按自己的目录与权限修改。新建普通服务用户前检查是否已有适合的用户，不重建正在工作的实例。

Python账号初始化工具是可选便利入口；如果机器没有Python3，使用同目录Node账号CLI的安全stdin接口，不把密码加在命令行。源码/主题不包含任何默认可登录密码。


### 单仓与分仓部署

QQHarnessBot与QQHarnessWorkbench均为公开开源仓库，可直接克隆。使用单仓部署时，QQHarnessBot主仓库也包含匹配的界面和网关：在主仓库的`deploy/botwork`目录运行`npm ci && npm start`，Nginx静态root指向主仓库`public/`，首页仍是`workbench.html`。不要为了下载源码索要或共享维护者的GitHub令牌。


### Linux可选媒体依赖与中文结果卡片

Debian/Ubuntu启用实际视频处理和服务端中文PNG结果卡片时，可按需安装：

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-noto-cjk fontconfig python3
```

其他发行版使用自己的包管理器。视频功能需ffmpeg/ffprobe；后台安全媒体缓存检查与对应Linux回归使用Python3。中文结果卡片需要完整中文字体，可在本机环境设置`QQ_CARD_FONT`指向已授权TTF/TTC字体；网页自带的OFL像素字集仅用于UI，不等于服务端中文字体。缺字体时业务保留文字结果，不会假装PNG已生成。

### QQ显式诊断入口

部署时同时检查桥接入站策略及SnowLuma的`statusCommand.enabled=false`。见[入站策略与无真人消息验收](docs/QQ-INCOMING-POLICY.md)。不得通过真实QQ发送测活命令验收；正常天气、提醒和内部定时任务不改入口。
