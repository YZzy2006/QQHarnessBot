# 🔌 配置地图：聊天、天气、地图、语音与媒体

[项目首页](../README.md) · [开发者部署](../README_DEVELOPER.md) · [AI 部署手册](../README_AI.md)

配置以仓库代码为准。`config.json` 是结构化设置，`.env` 是仅保存在你机器上的凭据和服务环境；两者都不能提交。供应商模型目录和账号权限可能变化，不保证示例模型对所有账号开放。

## 聊天模型在哪里改

1. 在你运行的 **DSH** 中配置模型供应商、API 地址和密钥；先确认它能独立完成一次对话。
2. 编辑机器人 `config.json` 的 `dsh.provider`、`dsh.model` 和 `dsh.reasoningEffort`，名称必须与 **该 DSH 实际列出的目录**一致。`provider` 是 DSH 中的供应商标识，不是随意填写的域名。
3. `dsh.baseUrl` 指向 DSH Web 服务。`dsh.authToken` 留空时按本机凭据获取 Cookie；不要把 DSH 启动凭据发送到陌生远程地址。
4. 可通过本地控制台或工作台“档案 / 模型设置”读取与修改当前模型设置。文件编辑通常需要受控重启桥接；界面支持的热切换以操作结果为准。已有会话与新会话都要检查，不清空记忆来“解决”换模型问题。

```json
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "your-provider-id",
    "model": "your-model-id",
    "reasoningEffort": "max",
    "allowRemote": false
  }
}
```

这是配置片段，请合并到本机配置，不能用它覆盖已有完整配置。聊天密钥在 DSH 中配置；`.env` 的 `DEEPSEEK_API_KEY` 还用于特定辅助文本/检索能力，不能用它代替 DSH 供应商设置。

## 服务入口一览

| 能力 | 在哪里配置 | 说明与源码 |
| --- | --- | --- |
| QQ 网关 | `snowluma.wsUrl`、`snowluma.httpUrl`、`snowluma.accessToken` | 连接你自己的 SnowLuma / OneBot；[连接层](../src/snowluma-conn.js) |
| 管理员与接入范围 | `ownerQQ`、`allow.private`、`allow.groups`、`deny` | 先放一个测试会话；`allowAllWhenEmpty:false`；工作台不能绕过白名单 |
| 人物卡 | `roles/*.md` 与角色管理入口 | 角色切换走控制台/工作台；[解析与实际生效小节](../src/role-card.js) |
| 和风天气 | `.env` 的 `HEFENG_WEATHER_API_KEY`、`HEFENG_WEATHER_API_HOST` | Host 是你账号对应的 `*.qweatherapi.com`；不能只填通用网站域名；也支持 `lifeServices.hefengHost` / `QWEATHER_API_HOST` 作为 Host 来源 |
| 高德定位 / POI | `GAODE_WEB_API_KEY` | 使用服务端 Web API Key，不是 JS SDK Key |
| 腾讯地图 | `TENGXUNDITU_API_KEY` | 保留源码已有变量拼写；不是 `TENCENT_MAP_KEY` |
| 天地图 | `TIANDITU_API_KEY` | 需账号具备实际搜索接口权限；HTTP403要检查权限，不反复换模型 |
| 百度地图 | `BAIDUDITU_API_KEY` | 服务端密钥；[天气/多地图实现](../src/life-services.js) |
| 语音合成 TTS | `BAILIAN_API_KEY` / `DASHSCOPE_API_KEY`；`socialV2.voice.ttsModel`、`ttsVoice` | 模型和音色必须配套；默认值见 [TTS 模块](../src/tts-bailian.js)，会话声线可覆盖全局值 |
| 语音识别 ASR | `BAILIAN_API_KEY` / `DASHSCOPE_API_KEY` | 当前实现使用 `qwen3-asr-flash`，**没有任意 ASR 模型热切换字段**；换厂商要改适配器并测试 [voice-asr.js](../src/voice-asr.js) |
| 音频格式处理 | `FFMPEG_PATH`、`FFPROBE_PATH`，或安装到 PATH | QQ 音频/视频音轨处理需相应可执行文件；不要把二进制或用户音频上传仓库 |
| 图片/视频视觉分析 | `QWEN_API_KEY` / `BAILIAN_API_KEY` / `DASHSCOPE_API_KEY`；`vision.model` | 和聊天模型是两条配置路径；[视觉适配](../src/qwen-vl.js)、[视频采样](../src/video-storyboard.js) |
| 视频音轨转写 | 百炼/通义密钥及 ffmpeg | 只按实际得到的采样/字幕回答，不等于完整观看、逐秒转写或实时通话 |
| 图片生成 / 编辑 | `QWEN_API_KEY` / `BAILIAN_API_KEY` / `DASHSCOPE_API_KEY`、`DOUBAO_API_KEY` | 具体支持取决于 [image-gen.js](../src/image-gen.js) 与当前配置；连续编辑另见 `QQ_IMAGE_EDIT_PROVIDER` / `QQ_IMAGE_EDIT_MODEL` |
| 博查搜索 | `BOCHA_API_KEY`，或受保护的 `state/.bocha-key` | DSH 启动的 MCP 子进程不一定继承机器人 `.env`，需核对实际进程环境 |
| DeepSeek辅助 / 检索 | `DEEPSEEK_API_KEY`，或 `state/.deepseek-key` | 和 DSH 聊天供应商配置区分 |
| 元宝检索兜底 | `YUANBAO_SEARCH_API_KEY`，或 `state/.yuanbao-search-key` | 可选，未配置不应假装检索成功 |
| B站登录与浏览 | 管理员私聊 `[B站登录]`；[视频说明](BILIBILI-VIDEO-CONTROL.md) | 自备有权使用的账号扫码。登录态在本机 `state/bilibili`，不放进 `.env.example` 或仓库；B站评论等写操作禁用 |
| 工作台域名 | `workbench.origin` | 完整 HTTPS Origin，例如 `https://workbench.example.com`，含协议不含路径；不是聊天模型地址 |
| 工作台本地账号 | `scripts/workbench-account.mjs` | 独立账号与加盐 scrypt 哈希；不是管理员 QQ 号、控制台 Token 或 DSH Cookie |
| 可选 MySQL 账号 | `QQ_WORKBENCH_DB_FILE` | [身份模块](../src/workbench-mysql-auth.js)；独立数据库中的 `admin_user` 兼容表；只读账号查询，不复用其他应用账号 |
| 可选头像 OSS | `QQ_WORKBENCH_OSS_FILE` + `QQ_WORKBENCH_DB_FILE` | [头像模块](../src/workbench-portrait.js) 读取独立受保护的OSS JSON配置，与博客和数据库无关；不是填一个任意图片 URL 就能上传。未配置时上传不可用，其余页面可使用 |

地图来源、个人城市、安静时段、会话声线等有对应管理操作。工作台中修改的是同一套底层状态；不能把只读“已配置”状态误认为浏览器拿到了密钥。

## 环境变量怎样生效

```bash
cp .env.example .env
chmod 600 .env
# 用编辑器填写需要的项目，未使用的项目保持空白
npm start
```

仓库 `npm start` 使用 `--env-file-if-exists=.env`。如果改为 systemd 直接运行 Node，应添加 `EnvironmentFile=/etc/qqharnessbot.env` 或使用相同 `--env-file-if-exists` 参数；`.env` 不会自动传播到已启动的 DSH 或它的 MCP 子进程。

`config.json`、`.env`、`state/`、私人人物卡、数据库/OSS 配置文件都属于本机资料。排障只输出“是否已配置”、错误码与脱敏字段，不打印密钥或整份进程环境。

## 保留与费用

- 新部署不会携带维护者的角色、QQ 账号、聊天、B站登录或数据库账号。
- B站分析正文、封面与标题最多保留72小时；过期后不会为了页面刷新自动重看。长期最小索引只保留视频标识与时间。
- 工作台列表、翻页和普通刷新不调用模型；手动生成日记、主动对话、视频分析等操作可能产生费用，需看操作说明和原额度。
- `[doge]`、`[狗头]`、`[狗头保命]` 指向 QQ 狗头277；`[傲娇]` 指向179。目录内部把179叫doge，不代表日常“狗头保命”应发179。


## 常用配置片段：先合并，再验证

### 天气与定位

在机器人的本机`.env`填自己的值：

```dotenv
HEFENG_WEATHER_API_HOST=your-api-host.qweatherapi.com
HEFENG_WEATHER_API_KEY=
GAODE_WEB_API_KEY=
TENGXUNDITU_API_KEY=
TIANDITU_API_KEY=
BAIDUDITU_API_KEY=
```

Host从你的和风控制台取得；四种地图不必全开，先配置一种有权限的服务端Key。改完重启真正读取该环境的机器人服务；若由DSH启动工具进程，还需核对它实际获得的服务配置，不是只刷新浏览器。使用`[天气查询][广州][明天]`或`[找店][广州][咖啡店]`在授权会话验收；查询成功后需用户明确要求才发送位置。

### 语音模型、音色与开关

以下片段合并到`config.json`，不覆盖已有`socialV2`设置：

```json
{
  "socialV2": {
    "voice": {
      "enabled": true,
      "ttsEnabled": true,
      "ttsModel": "qwen3-tts-flash",
      "ttsVoice": "Cherry",
      "dir": "audio",
      "maxSeconds": 300,
      "maxBytes": 20971520,
      "maxPerMinute": 2,
      "maxPerHour": 10,
      "allowAbsolutePath": false
    }
  }
}
```

`BAILIAN_API_KEY`或`DASHSCOPE_API_KEY`填在本机环境。`enabled`是AI语音总闸，`ttsEnabled`是合成开关，还要满足会话/工具权限；某会话的专用声线优先于全局值。已有角色说话习惯和记忆不随换声线清空。示例模型/音色须在你账号中可用；不要将音色名当成模型名，或者将聊天模型字段当TTS字段。

ASR当前是独立的`qwen3-asr-flash`适配器，换其他ASR供应商需要代码适配，不承诺上述JSON能更换识别模型。音频库只允许目录内有权使用的文件；不会因`allowAbsolutePath`就允许模型外发任意本机文件。

### 图片、视频与B站

视觉模型在`vision.model`，密钥来自相应通义/百炼环境。外部ffmpeg与ffprobe须在PATH或通过`FFMPEG_PATH`/`FFPROBE_PATH`指定；离线抽帧测试自身要求命令在PATH可见。

B站使用管理员私聊`[B站登录]`单独扫码，当前QQ人物卡用于选片和感想，不另建B站人格。纯分享可以用`[分享视频][BV号或链接]`，看过再分享用`[观看视频][BV号或链接]`；跨会话操作要在管理员本人私聊选明确目标。登录后不自动取得B站写权限，评论等写操作始终禁用。旧资料过期后不会为了工作台刷新重读扣额。

### 最小配置优先

先完成“自己的DSH模型 + 自己的QQ网关 + 一个测试会话 + 本地工作台账号”。天气/地图、语音、图片、B站、MySQL、OSS逐项增加，每次只验收一个服务；缺少可选服务不应阻断基本聊天和登录。不要一次性复制维护者的线上配置。


### 服务端中文结果卡片

`QQ_CARD_FONT`可指定本机完整中文TTF/TTC字体路径；Linux可使用发行版提供的Noto CJK与fontconfig。不要上传维护者的系统字体文件。网页本地OFL像素字集只覆盖界面字形，不用于任意中文内容渲染；缺字/缺字体时保留原文字结果。


## 逐会话主动视频开关与限额

工作台「樱良 → 会话开关」可开关每段对话的**主动发视频**；「视频」页可管理同一开关、设置每日上限，并查看今日已用量。两处修改同一份机器人本地状态，不另建聊天数据库。

| 设置 | 行为 |
| --- | --- |
| 跟随默认 | 使用原私聊／群聊主动分享默认上限；不会覆盖其他会话 |
| 独立上限 | 当前会话的0–100整数，优先于类别默认值 |
| 0 | 暂停此会话自动视频分享，保留历史与今日用量 |
| 主动视频关闭 | 取消后续自动任务；不会停止管理员手动指定的视频分享 |

计数按北京时间每日重算，修改限额不会清零当天的账本。待确认发送保守占额，已确认失败释放。管理员手动指定分享不占主动额度，仍受QQ限流与权限约束。此上限不承诺发满：沿用原浏览时段、每日随机计划（私聊0–1、群聊1–3）、安静时段和全局每日深读最多6条限制。

手动开启会把该会话固定加入自动浏览目标；关闭后不会被“最近活跃好友”规则重新打开。未修改的目标继续沿用旧选择行为。实际设置位于机器人私有`state/bilibili/control.json`的`targets[会话键]`中：`enabled`是开关，`dailyLimit`省略时跟随默认，`manualSelect`记录显式加入。**不要把此状态文件提交到Git。**

旧页面并发修改会被拒绝，刷新后重试；保存不会调用模型、立即发送视频或开启B站评论等写操作。关闭或修改额度会撤销尚未发送任务的授权。
