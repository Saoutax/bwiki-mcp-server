# Changelog

## [1.3.0](https://github.com/Saoutax/bwiki-mcp-server/compare/v1.2.1...v1.3.0) (2026-11-27)


### Features

* **config:** 默认编辑摘要改为 BWiki MCP Server ([8117b53](https://github.com/Saoutax/bwiki-mcp-server/commit/8117b53a23edd3c559d392b323381205f1184b47))
* **moderation:** 感知审核队列 ([3e0ac17](https://github.com/Saoutax/bwiki-mcp-server/commit/3e0ac17349060c6c57addc0d7c5ed520f8e7d57a)), closes [#9](https://github.com/Saoutax/bwiki-mcp-server/issues/9)
* **search:** 支持 CirrusSearch 检索参数 ([60881e3](https://github.com/Saoutax/bwiki-mcp-server/commit/60881e351621bcb8d38be22477adf80568114369)), closes [#12](https://github.com/Saoutax/bwiki-mcp-server/issues/12)
* **tools:** 新增随机页面工具 ([4a52032](https://github.com/Saoutax/bwiki-mcp-server/commit/4a52032d3b264249e58b631792f521468ad8c27f)), closes [#10](https://github.com/Saoutax/bwiki-mcp-server/issues/10)
* **upload:** 按站点上限预检上传大小 ([7bc8f53](https://github.com/Saoutax/bwiki-mcp-server/commit/7bc8f53c967dddc8a87fead80d4cb75c69fa8235)), closes [#11](https://github.com/Saoutax/bwiki-mcp-server/issues/11)


### Documentation

* 同步新工具与审核说明 ([cbdab40](https://github.com/Saoutax/bwiki-mcp-server/commit/cbdab40161e5c23d531bd224a96944130e7b95c6))

## [1.2.1](https://github.com/Saoutax/bwiki-mcp-server/compare/v1.2.0...v1.2.1) (2026-11-18)


### Bug Fixes

* **auth:** 修复登录态传播与会话文件处理 ([16a9bda](https://github.com/Saoutax/bwiki-mcp-server/commit/16a9bda2a4ab5b1c83dca5c1dcf95eaef565e054))
* **files:** 修复上传覆盖、命名空间前缀与 URL 抓取 ([72febac](https://github.com/Saoutax/bwiki-mcp-server/commit/72febacf9022af0983e75067970c07fee83d2e35))
* **runtime:** 修复 stdio 协议中断与关闭排空 ([f138e98](https://github.com/Saoutax/bwiki-mcp-server/commit/f138e98acf5ccc29558f274e3ca2d6120ed4bce5))
* **tools:** 修复批量读页、非法标题与分节写入 ([936d8b5](https://github.com/Saoutax/bwiki-mcp-server/commit/936d8b53fe08c6bb2785dfea83a41b03b57e4732))


### Documentation

* 同步会话语义与浏览器支持 ([0f815a7](https://github.com/Saoutax/bwiki-mcp-server/commit/0f815a74c10ff091fa87257ee2539bb4d6bbdc96))
* 更新仓库地址为 Saoutax/bwiki-mcp-server ([8d49f53](https://github.com/Saoutax/bwiki-mcp-server/commit/8d49f53f47ad4d3743efbd36a215e2ad69ab7798))
* 移除 NOTES.md ([055de02](https://github.com/Saoutax/bwiki-mcp-server/commit/055de02d76bbdfb45fe0e2a99f6c67f2a1569e74))


### Build System

* **deps:** 移除未使用依赖并调整打包目标 ([ecd43f7](https://github.com/Saoutax/bwiki-mcp-server/commit/ecd43f7aeb50160025d8565a4d8c6da69d686bf6))

## [1.2.0](https://github.com/Saoutax/bwiki-mcp-server/compare/v1.1.0...v1.2.0) (2026-11-17)


### Features

* **config:** 支持配置编辑摘要与全局变更标签 ([6181354](https://github.com/Saoutax/bwiki-mcp-server/commit/6181354f4ec88cfc1a863341ca134aee3e58a6f2))


### Bug Fixes

* **scripts:** 修正测试脚本的失败判定 ([e269f3d](https://github.com/Saoutax/bwiki-mcp-server/commit/e269f3d356f0ec299fa5b0b1483dc5cba4f651b5))


### Documentation

* **config:** 示例配置只保留必填项 ([ddf9639](https://github.com/Saoutax/bwiki-mcp-server/commit/ddf9639f4264af24028b39c1eed692d594851f27))
