# 磁盘维护（2026-11-03）

管理员本人私聊可用：`[磁盘状态]`、`[清理预览]`、`[清理磁盘]`、`[清理日志]`、`[磁盘帮助]`，也可说“帮我清理一下磁盘”。群内拒绝执行，普通好友不能调用。指令直接执行固定模式，不经过聊天模型，不接受路径或 shell 参数，不收费调用模型。

- 每15分钟检查根分区使用率，达到85%才自动执行；每天04:10（服务器Asia/Shanghai）另做例行维护。全局非阻塞锁避免并发；清理范围不足仍报告高占用，不扩大删除范围。
- DSH临时目录仅匹配`/tmp/dsh-workspace-changes-XXXXXX`；要求根及子项均超过48小时，且早于当前DSH进程启动时间，限定Git objects结构，无活动进程引用，无符号链接/硬链接/跨设备。无法确认进程身份时保留快照。当前DSH进程所属快照一律保留，即使暂时没有打开文件。
- 系统journal保留最多7天且归档总量最多512MiB；先rotate后vacuum，活跃记录保留。系统文本日志仅messages/secure/cron/maillog/spooler，按天或20MiB轮换，14份、最长14天、gzip压缩，由rsyslog HUP重新打开。专用logrotate状态与配置，不修改全局规则。
- 博客访问日志（整个`/www/wwwlogs`）、数据库、配置、任务、人物卡、聊天历史、记忆、QQ登录数据/容器卷、回滚备份、运行依赖均不在清理范围；不执行Docker prune，不清swap，不强制drop_caches。媒体临时文件沿用原有每小时安全清理器。
- `.git/info/exclude`追加`/backups/`和`/.runtime/`，防止DSH文件变更插件把备份、依赖再次做整份快照；保留插件本体和网页查看能力，无需重启DSH。部署不要覆盖原exclude。
- 不在此次维护中卸载未知依赖：机器人插件合计约84KiB，并非主要占用；PHP/PM2等跨站依赖没有仅凭进程名就删除。

入口：`scripts/disk-maintenance.py status|preview|apply|auto|scheduled`（服务器root权限）；结果`state/disk-maintenance/latest.json`，不含聊天正文/凭据。定时器`qq-disk-maintenance.timer`和`qq-log-retention.timer`。手动预览只统计过期快照，不预估journal压缩节省量；释放空间按文件系统实际可用量差计算，期间正常写入会影响结果。

首次实测：40GiB根分区91%→80%，实际可用量增加4,581,236,736字节（约4.27GiB），删除29个孤儿目录（约1.76GiB），其余来自journal保留和文本日志压缩。82个博客日志inode保持且大小未减少；关键保护文件无漂移，DSH/QQ桥接PID和SnowLuma身份均未变。首次清理无服务重启；仅为加载新增私聊指令另做一次桥接维护重启，详见部署结果。

验证：隔离安全测试覆盖符号链接、硬链接、当前进程快照、活跃引用、未知文件、最近内容、缺少进程身份、预览不删除、85%边界和部分失败；QQ真实入口通过隔离harness校验本人私聊、群/非管理员拒绝、不进模型与帮助入口。没有发送真实QQ测试消息。

依据：[systemd journalctl](https://www.freedesktop.org/software/systemd/man/255/journalctl.html)、[logrotate手册](https://www.man7.org/linux/man-pages/man8/logrotate.8.html)；DSH已安装`@deepseek-ai/dsh-workspace-changes/README.md`及`lib/index.js`说明快照属于Host内存中的Session、dispose删除，重启后旧快照不恢复。
