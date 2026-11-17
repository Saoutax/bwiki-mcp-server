# 项目记录

## 新增 `list-pages` 读取工具（list=allpages）

- 新增 `src/tools/list-pages.ts`，并登记进 `standardTools.ts`（工具数 30 → 31）。
- 能按命名空间枚举全部页面，标题排序，返回 `title / pageId / namespace`。
- 参数：`namespace`（数字 ID，默认 0=主命名空间）、`from`、`to`、`direction`、`filter`（all/redirects/nonredirects）、`limit`（≤500，默认 500）、`continueFrom` 翻页。
- README 工具表、冒烟 `mustHave`、冒烟功能断言均已补上。

### 实测确定的边界语义（在 BWiki 实测）

- `from` 与 `to` 均为**闭区间**：两处边界标题都出现在结果里（例如 ns0 `from=2024 to=2025` 返回 2024、2025）。
- `from`/`to` 接受**带前缀**或**不带前缀**的标题（如 `模块:CSS` 或 `CSS`），传入前会按站点命名空间表剥离前缀。
- 若传入的标题前缀指向**别的命名空间**（如 `namespace=828` 却传 `模板:Arguments`），直接拒绝并说明应属哪个命名空间，而不是静默给出错误结果。
- 降序时 `from` 为上限、`to` 为下限，仍均含端点。
- 空边界值（如 `from=""`）按省略处理。

### 实现细节

- 命名空间名表取自 `siteInfo.ts` 的 `resolveSiteInfo`（`SiteInfo` 新增 `namespaceNames`：归一化名/别名 → ID，含别名）。仅当 `from`/`to` 含冒号时才触发一次 siteinfo 请求（已按 1 小时缓存）。
- 没有复用 `mwn.Title.nameIdMap`：经 `wrapMwnErrors` 代理后 `mwn.Title` 是包装函数，静态属性不可用，故改用站点信息缓存。

### 验证

- typecheck 0 错误；构建 + 打包通过。
- 守卫 7/7、启动期探针 3/3 通过；冒烟中 `list-pages` 断言通过（工具总数 31 通过）。
- 冒烟的 `list-wikis 默认分页` 仍硬编码 `Total: 993`，而农场名册已涨到 996 导致该条失败——属既有脆弱断言，与本次任务无关，未改动。

### 发布状态

- 代码与 bundle 已就绪，但**尚未**升版本号 / 提交 / 推送 / 发布。
- 改动要让正在运行的 MCP 生效，须彻底重启（关掉 OpenCode 再开）。

## 测试迁移到 vitest（scripts/ → tests/）

逐文件判定后，只迁移了真正是"测试"且离线可跑的 3 个，其余保留为手工探针：

| 原脚本                                                                                                           | 去向                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `scripts/probe-edit-summary.mjs`                                                                                 | `tests/unit/edit-summary.test.ts`（27 例）                                                                   |
| `scripts/probe-liveness-guard.mjs`                                                                               | `tests/unit/session-liveness.test.ts`（7 例）                                                                |
| `scripts/probe-headers.mjs`                                                                                      | `tests/unit/mwn-headers.test.ts`（5 例）                                                                     |
| `scripts/smoke-stdio.mjs`                                                                                        | 保留，改名为 `pnpm run test:smoke`；退出码改为失败即非 0（原先无条件 `exit(0)`，冒烟失败永远不会让命令变红） |
| `probe-liveness` / `probe-writes` / `probe-mwn-auth` / `probe-mwn-compat` / `probe-referer` / `probe-cookie-jar` | 保留：需要真实会话、真实网络，或会写真实页面                                                                 |

关键变化：

- 用例改为直接导入 `src/`，不再依赖 `dist/`，因此 `pnpm test` 前置条件从"先 build"变成"什么都不用"。
- `session-liveness` 的 wiki key 改成字面量 `'test-wiki'`，不再经 `probe-target.mjs` 读 `config.json`——CI 里那段临时 `CONFIG` 的铺垫因此可以删掉。
- 新增 `vitest.config.ts`（只收 `tests/unit/**`）、`tsconfig.test.json`（`noEmit` 检查 src+tests）、`.oxlintrc.json` 的 overrides（vitest 配置需默认导出）。
- `esbuild` 升到 `^0.28.2`：vitest 5 依赖的 vite 8 把 esbuild 声明为 `^0.27 || ^0.28` 的 peer，留在 0.25 会让 `pnpm install` 报 unmet peer。构建与 bundle 已复验通过。

顺带修掉的测试自身问题（退出码一改就暴露）：

- `scripts/smoke-stdio.mjs` 的 `get-page 读到内容` 原按「返回 > 50 字符」判断，而本 wiki 首页的 wikitext 就是 `{{首页}}`（正文 5 字符），必然误报；改为看结构化载荷（`source` 或 `latestRevisionId`）。
- `scripts/probe-mwn-compat.mjs` 的退出码同样改为失败即非 0，与其他探针一致。

验证：39 例全绿（无需构建、无需 `config.json`）；`CONFIG` 指向不存在的文件时同样全绿；lint / format / typecheck / build / `bundle.cjs --help` 均通过；`pnpm run test:smoke` 16/16 通过（修复前因上述断言以退出码 1 失败）。
