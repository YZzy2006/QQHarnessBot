# 来源与第三方说明

## 上游来源

本项目由 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 扩展而来，
公开版以本地修改后的代码快照整理，参考上游提交 `9df6a7e`。
新建发布历史用于避免夹带运行数据，不表示这些代码全部由本仓库维护者原创。
原始版权声明和 MIT 授权正文保留于 `LICENSE`，修改和新增部分归相应贡献者所有。

## 第三方组件

- DeepSeek Harness 由其上游维护，须自行安装并遵守其许可证与服务要求。
- SnowLuma 本体使用独立的源码可见非商业许可，原生组件另受其专有条款约束。
  本仓库不包含它的源码、原生二进制、安装镜像、登录态或自动部署程序。
  其许可对商业用途、修改版/衍生版公开发布等作有限制；涉及这些用途应先向权利人确认。
  参见 [SnowLuma LICENSE](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE)。
- 本项目使用 npm 依赖 `@snowluma/sdk` 与 OneBot 网关通信；该包声明
  `SEE LICENSE IN LICENSE`。不要将本项目 MIT 许可证误解为对该依赖的重新授权。
  `postinstall` 只对使用者本机安装副本的相对导入补扩展名，不提交修补后的依赖代码。
  公开版不携带上游的工具目录快照，也不依赖未使用的 `@snowluma/mcp` 包。
- SheetJS 使用官方 CDN 的固定版本，许可见所安装包中的 `LICENSE`。
  安装来源说明：[SheetJS 官方安装文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)。
- 其他依赖分别遵守其包内许可证；依赖清单与具体版本以 `package.json` 和 `package-lock.json` 为准。

本项目与腾讯、QQ、SnowLuma、DeepSeek 等第三方不存在因本仓库发布而产生的官方背书关系。
