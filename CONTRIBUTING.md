# 贡献与发布流程

## 本地开发

使用 Node.js 22.13 或更新版本，运行 `npm ci` 和 `npm test`。
测试应使用临时目录和假接口，不能依赖维护者的配置、私人角色卡、真实密钥或 QQ 账号。
不要为运行测试清空用户记忆、重建会话或发出真实 QQ 消息。

## 提交前

```bash
npm run hooks:install
npm run check:release
npm test
```

本仓库按 `release-files.json` 管理允许提交的路径。新增文件需显式加入该清单，
再运行检查；不要给某个源文件添加整文件的密钥扫描白名单。
示例凭据统一使用明显的 `fixture-` / `fake-` / `test-` 标记，不使用看似真实的生产密钥。

## 安全上传

```bash
# 在加入暂存区之前先检查工作树
npm run check:release
# 精确按清单暂存；此命令会在执行 git add 前再次扫描
node scripts/stage-release.mjs
npm run check:staged
git commit -m "chore: 更新经过检查的发布内容"
npm run check:history
# 还需用已安装的 Gitleaks 做目录与 Git 历史扫描
gitleaks dir . --redact=100
gitleaks git . --redact=100
git push origin main
```

本地钩子检查暂存区 / 历史，CI 运行离线回归、发布检查与 Gitleaks。
不要使用 `--no-verify` 跳过检查，也不要把生产运行目录直接推到公开仓库。
钩子和 CI 都不能替代人工审查，未知格式的密钥或个人资料仍可能需要额外规则识别。

## 变更范围

保留上游许可证与署名；新功能描述清楚行为、权限边界、验证方法和已知限制。
依赖升级需更新锁文件并回归；不要把“供应商请求成功”写成“QQ 客户端已验收”。
