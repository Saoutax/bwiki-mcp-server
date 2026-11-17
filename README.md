# BWiki MCP Server

本仓库修改自 [aspd199/bwiki-mcp-server](https://github.com/aspd199/bwiki-mcp-server)。

一个 MCP（Model Context Protocol）服务器，让 LLM 客户端以自己登录的 bilibili 账号读写的 [BWiki](https://wiki.biligame.com)——bilibili 旗下游戏 WIKI 所在的 wiki 农场。

## 特性

- **bilibili 通行证认证。** 通过官方 bilibili 登录页登录，由本机真实浏览器驱动。扫码、密码、短信、微信/微博/QQ 等全部登录方式都可用，因为这些都不是本项目自己实现的。
- **不降级为匿名。** 没有会话，或已有会话不再被识别时，服务器拒绝服务并断开连接，绝不悄悄退回匿名访问。
- **写操作前校验身份。** BWiki 对失效的 cookie 不会拒绝，而是把请求当作匿名访客处理，于是过期凭证仍能让写操作成功，只是页面署名变成调用方的出口 IP。因此每次写操作前都先校验身份，校验失败即终止会话。
- **感知 wiki 农场。** 一份凭证覆盖农场内所有 WIKI；`list-wikis` 从农场名册枚举站点，而不只是读本地配置。
- **克制地发请求。** 所有请求串行化，间隔超过一秒；遭遇 EdgeOne 拦截（HTTP 567/514）时自动冷却，而不是反复重试。
- **仅限 HTTPS。** 非 HTTPS 的外部请求一律拒绝，会话 cookie 以 host-only 方式注入。

## 工具

所有操作 wiki 的工具都接受可选参数 `wiki`，用于指定目标站点——传站点代号即可（可用 `list-wikis` 查到）。省略时使用配置中的默认站点（见[配置](#配置)）。每个响应都会注明本次调用作用的站点；成功的响应同时提供两种载荷：`content` 中是叙述文本，`structuredContent` 中是 JSON。

### 页面读操作

| 名称                    | 说明                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `compare-pages`         | 按版本号、标题或指定 wikitext 对比同一页面的两个版本。                                                                 |
| `get-category-members`  | 列出分类成员（每次最多 500 条，用 `continueFrom` 翻页）。                                                              |
| `get-file`              | 获取一个文件页面。                                                                                                     |
| `get-file-data`         | 以内联 base64 返回图片字节，供模型直接查看。返回缩放后的版本（用 `width` 指定）；不可渲染的类型会报错。                |
| `get-links-here`        | 列出引用了某页面的页面，包含经由重定向到达的（每次最多 500 条）。                                                      |
| `get-page`              | 获取一个 wiki 页面。                                                                                                   |
| `get-page-history`      | 列出页面的近期修订。                                                                                                   |
| `get-pages`             | 一次获取多个页面（最多 50 个）。                                                                                       |
| `get-recent-changes`    | 列出全站近期变更，可按时间、命名空间、用户、标签、类型过滤。                                                           |
| `get-revision`          | 获取页面的指定修订版本。                                                                                               |
| `get-site-info`         | 获取站点的关键设置：MediaWiki 版本、内容语言、命名空间、已安装扩展、许可协议。                                         |
| `list-pages`            | 按命名空间列出页面，按标题排序（每次最多 500 条，用 `continueFrom` 翻页）。                                            |
| `list-wikis`            | 列出农场内的 WIKI——代号、站点名、地址、是否只读或默认，以及是否已在本地配置。支持 `limit`、`query`、`configuredOnly`。 |
| `parse-wikitext`        | 把 wikitext 渲染成 HTML，不保存。                                                                                      |
| `search-page`           | 对页面标题与正文做全文搜索。                                                                                           |
| `search-page-by-prefix` | 按标题前缀搜索页面。                                                                                                   |
| `whoami`                | 报告当前会话认证的身份——用户名、是否匿名、所属用户组。                                                                 |

### 页面写操作

写操作要求已登录，且账号在目标站点具备相应的用户权限。

| 名称                   | 说明                                                   |
| ---------------------- | ------------------------------------------------------ |
| `create-page`          | 创建新页面。                                           |
| `delete-page`          | 删除页面。                                             |
| `move-page`            | 移动（重命名）页面。                                   |
| `protect-page`         | 保护或取消保护页面。                                   |
| `undelete-page`        | 恢复已删除的页面。                                     |
| `update-file`          | 用本地文件上传文件的新版本。                           |
| `update-file-from-url` | 用 URL 上传文件的新版本。                              |
| `update-page`          | 覆盖页面、在末尾追加或开头插入内容，或只改写其中一段。 |
| `upload-file`          | 从本地文件上传新文件。                                 |
| `upload-file-from-url` | 从 URL 上传新文件。                                    |

### 会话管理

| 名称           | 说明                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| `bwiki-login`  | 打开官方 bilibili 登录页，等待登录完成并保存会话。唯一无需会话即可运行的工具。 |
| `bwiki-logout` | 删除已保存的会话。                                                             |

### 扩展包

各扩展包的工具只在安装了对应扩展的站点上注册。

**Semantic MediaWiki**

| 名称                  | 说明                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `smw-list-properties` | 列出 Semantic MediaWiki 属性，并附可直接复制的 `smw-query` 模板。 |
| `smw-query`           | 执行 Semantic MediaWiki 的 `#ask` 查询。                          |

## 环境要求

- Node.js 22.12 或更高版本。
- pnpm 11 或更高版本（`package.json` 的 `packageManager` 固定为 pnpm 12.6.0；启用 Corepack 时会自动使用该版本）。
- 已安装 Microsoft Edge 或 Google Chrome。登录流程通过 `puppeteer-core` 驱动其中之一，不会额外下载浏览器。
- 一个 bilibili 账号，且具备你要调用的工具所需的用户权限。

## 安装

先构建服务器，再把 MCP 客户端指向构建产物。

```bash
git clone https://github.com/aspd199/bwiki-mcp-server.git bwiki-mcp-server
cd bwiki-mcp-server
pnpm install
pnpm build        # 一次完成 TypeScript 编译与单文件打包
```

然后把 `config.example.json` 复制为 `config.json`，填入要使用的站点（见[配置](#配置)）。没有配置文件时服务器拒绝启动。

构建产出 `dist/bundle.cjs`，单文件，不依赖 `node_modules`。

### 从 GitHub Release 使用

不想从源码构建时，可以直接下载最新 GitHub Release 中的：

- `bwiki-mcp-server-<版本>.cjs`：已内联全部依赖（含 `puppeteer-core`），无需 `node_modules`
- `config.example.json`

要求与源码安装相同：Node.js 22.12+，本机已安装 Edge 或 Chrome。把 `config.example.json` 复制为 `config.json` 并填入站点代号，首次使用执行：

```bash
node /path/to/bwiki-mcp-server-<版本>.cjs login
```

然后在 MCP 客户端中把 `args` 指向该 `.cjs` 文件、`CONFIG` 指向 `config.json`（见下方标准配置）。

### 标准配置

多数客户端读取同一套服务器配置块。把它粘贴到下表对应的文件中，并把 `mcpServers` 换成该客户端的根键：

| 客户端                       | 配置文件                                                           | 根键              |
| ---------------------------- | ------------------------------------------------------------------ | ----------------- |
| Cursor                       | `~/.cursor/mcp.json`，或项目内 `.cursor/mcp.json`                  | `mcpServers`      |
| VS Code                      | 工作区 `.vscode/mcp.json`，或命令 **MCP: Open User Configuration** | `servers`         |
| Claude Desktop               | `claude_desktop_config.json`                                       | `mcpServers`      |
| Devin Desktop（原 Windsurf） | `~/.codeium/windsurf/mcp_config.json`                              | `mcpServers`      |
| Zed                          | `~/.config/zed/settings.json`                                      | `context_servers` |
| LM Studio                    | `~/.lmstudio/mcp.json`                                             | `mcpServers`      |

```json
{
    "mcpServers": {
        "bwiki-mcp-server": {
            "command": "node",
            "args": ["/absolute/path/to/bwiki-mcp-server/dist/bundle.cjs"],
            "env": {
                "CONFIG": "/absolute/path/to/bwiki-mcp-server/config.json"
            }
        }
    }
}
```

### Claude Code

```bash
claude mcp add bwiki-mcp-server -e CONFIG=/absolute/path/to/config.json -- node /absolute/path/to/dist/bundle.cjs
```

### OpenCode

OpenCode 使用自己的配置结构而非 `mcpServers`；把下面这段加入项目根目录的 `opencode.json`，或全局的 `~/.config/opencode/opencode.json`。

```json
{
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
        "bwiki-mcp-server": {
            "type": "local",
            "command": ["node", "/absolute/path/to/dist/bundle.cjs"],
            "environment": {
                "CONFIG": "/absolute/path/to/config.json"
            }
        }
    }
}
```

## 配置

服务器读取一个 JSON 配置文件，默认是工作目录下的 `config.json`，也可由 `CONFIG` 指定其他路径。

**只填站点代号。** BWiki 所有 WIKI 共用 `wiki.biligame.com` 这个 host，按路径第一段区分，所以地址完全由代号推出——没有 server、没有路径要填。

```json
{
    "wikis": ["你的站点代号"]
}
```

`config.example.json` 就是这份最小示例，只含必填项。`uploadDirs`、`editSummary`、`editTags` 均为可选项，说明见下表与后续小节。

| 字段          | 必填 | 说明                                                                                                                     |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `wikis`       | 是   | 要使用的站点代号数组，第一个即默认站点（工具调用省略 `wiki` 参数时用它）。至少填一个，否则服务器拒绝启动。               |
| `uploadDirs`  | 否   | 上传工具允许读取的绝对路径目录。不填或空数组即禁用上传。见[上传目录](#上传目录)。                                        |
| `editSummary` | 否   | 编辑摘要生成方式：是否附加来源后缀、自定义模板。不填保持内置文案。见[编辑摘要与变更标签](#编辑摘要与变更标签)。          |
| `editTags`    | 否   | 写入时附加的 MediaWiki 变更标签，全局作用于所有已配置站点。不填即不打标签。见[编辑摘要与变更标签](#编辑摘要与变更标签)。 |

站点代号怎么查：调用 `list-wikis` 工具，它会列出整个农场的代号。例如 `["station-a", "station-b"]` 表示同时配置两个站点。

由代号自动推出的值（不需要也不允许写在配置里）：

| 推出项   | 规则                                                   |
| -------- | ------------------------------------------------------ |
| 站点地址 | `https://wiki.biligame.com/<代号>`                     |
| 页面路径 | `/<代号>`                                              |
| API 入口 | `https://wiki.biligame.com/<代号>/api.php`             |
| 站点名称 | 从 wiki 自身的 siteinfo 实时读取，配置文件无法与之不符 |

写成旧的对象格式（`{"wikis": {"代号": {}}}`）会被明确拒绝并提示改为数组，而不是静默忽略。

只需列出你打算调用的 WIKI。`list-wikis` 无论如何都会报告整个农场，所以新增一个站点只是一条配置的事，不需要先做站点发现。

### 上传目录

`upload-file` 与 `update-file` 从本地磁盘读取文件，`uploadDirs` 决定它们能读哪些位置。

**默认禁用。** 不配置时这两个工具直接拒绝，不会上传任何文件：

```
uploads are disabled on this server (no upload directories configured).
```

启用需要列出允许的绝对路径：

```json
{
    "wikis": ["你的站点代号"],
    "uploadDirs": ["D:/Pictures/wiki", "/home/me/wiki-assets"]
}
```

规则：

| 规则                     | 说明                                               |
| ------------------------ | -------------------------------------------------- |
| 必须是绝对路径           | 相对路径在加载时报错                               |
| 目录必须已存在           | 启动时解析真实路径，不存在则拒绝启动               |
| 须在允许目录或其子目录下 | 调用方给出的文件路径经 `realpath` 解析后按前缀匹配 |
| 符号链接按其真实位置判定 | 允许目录内的链接若指向外部，该文件仍会被拒绝       |

也可以用环境变量 `MCP_UPLOAD_DIRS`，以 `:` 分隔，与配置项合并生效。

`upload-file-from-url` 与 `update-file-from-url` 读取的是远程 URL，不受此限制。

### 编辑摘要与变更标签

写工具默认给每次写入附加来源说明：有 `comment` 时是 `<你的 comment> (via <工具名> on MediaWiki MCP Server)`，没有时是 `Automated edit (via <工具名> on MediaWiki MCP Server)`。这两段文案和变更标签都可以在配置里调整：

```json
{
    "wikis": ["你的站点代号"],
    "editSummary": {
        "attribution": true,
        "template": "{comment}（via {tool}）",
        "noCommentTemplate": "自动编辑（via {tool}）"
    },
    "editTags": ["bwiki-mcp"]
}
```

| 字段                            | 默认值                                                | 说明                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editSummary.attribution`       | `true`                                                | 为 `false` 时服务器不生成任何文案，只把调用方 `comment` 原样作为摘要；没有 `comment` 就不发摘要参数。此时 `template` 与 `noCommentTemplate` 被忽略。 |
| `editSummary.template`          | `{comment} (via {tool} on MediaWiki MCP Server)`      | 有 `comment` 时使用。`{comment}` 替换为调用方给的摘要，`{tool}` 替换为工具名。                                                                       |
| `editSummary.noCommentTemplate` | `Automated edit (via {tool} on MediaWiki MCP Server)` | 调用方未给 `comment` 时使用；其中的 `{comment}` 渲染为空串。                                                                                         |
| `editTags`                      | `[]`                                                  | 写入时附加的 MediaWiki 变更标签，全局作用于所有已配置站点；空数组表示不发送 `tags` 参数。                                                            |

规则：

| 规则             | 说明                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 占位符           | 只替换 `{comment}` 与 `{tool}`，其它 `{...}` 原样保留；`comment` 内出现的 `{tool}` 不会被二次展开。                                                  |
| 空摘要           | 模板渲染结果为空时按「未提供」处理，不发送空摘要，以免覆盖 MediaWiki 自己的默认理由。                                                                |
| 忘记 `{comment}` | `template` 不含 `{comment}` 会丢弃调用方写的理由，启动时打 warning。                                                                                 |
| 摘要缺失 ≠ 空串  | `attribution: false` 且没有 `comment` 时，删除、恢复、保护类操作省略 `reason`，由 MediaWiki 写入自己的默认理由。                                     |
| 标签是全局的     | 没有按站点覆盖：每个写入（编辑、创建、删除、恢复、移动、保护、上传）都会带上这些标签。                                                               |
| 标签前提         | 标签必须在每个已配置站点的 `Special:Tags` 中已定义，且账号具备 `changetags` 权限，否则该站写入会被 wiki 拒绝。不打算给所有站点打同一组标签时请留空。 |
| 长度             | 超长摘要由 wiki 自身拒绝，本服务不截断；来源后缀会占用摘要长度配额。                                                                                 |

## 认证

登录方式只有一种：官方 bilibili 登录页。

1. 调用 `bwiki-login`，会打开浏览器窗口并停在通行证登录页。
2. 用你习惯的方式登录——扫码、密码、短信、微信/微博/QQ 均可。
3. 工具会等待登录完成，通过 DevTools 协议取出会话 cookie，向 wiki 确认该身份有效后写入磁盘。

会话文件位置：

- Windows：`%APPDATA%\bwiki-mcp-server\session.json`
- 其他平台：`~/.config/bwiki-mcp-server/session.json`

`bwiki-logout` 会删除它。会话就是普通文件，请像对待其他凭证一样对待它。

### 会话失效时会怎样

服务启动前，启动检查会先验证已保存的会话。验证不通过时，服务器会带原因退出，而不是建立连接。

运行期间，BWiki 不会拒绝失效的 cookie，而是把请求当作匿名访客处理，并用调用方的出口 IP 顶替用户名。成功响应里没有任何字段会告诉你身份已经变了。因此：

- **写操作**前会先校验身份。若 wiki 不再报告 bilibili UID，写操作被拒绝，响应说明原因，随后连接关闭。服务器绝不会以 IP 身份写入。
- **读操作**不做校验。匿名读返回的本来就是同一份公开内容，多花一次请求买不到任何东西。
- **传输失败不算登出。** wiki 不可达说明不了凭证状态，因此报为上游错误、连接保持。一次网络抖动不该让你重新扫码。

一旦判定会话失效，这个结论会保持：后续写操作直接拒绝，不再重复探测。

## 环境变量

| 名称                      | 说明                                                                                                           | 默认值         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------- |
| `CONFIG`                  | 配置文件路径                                                                                                   | `config.json`  |
| `MCP_LOG_LEVEL`           | 日志最低级别。可选 `debug`、`info`、`notice`、`warning`、`error`、`critical`、`alert`、`emergency`、`silent`。 | `debug`        |
| `MCP_CONTENT_MAX_BYTES`   | 工具返回内容正文的字节上限，按每个响应计一次。可按所用客户端的响应预算调整。                                   | `75000`        |
| `MCP_FILE_DATA_MAX_BYTES` | `get-file-data` 响应中 base64 数据的硬上限。超限的调用直接报错，不截断。                                       | `1000000`      |
| `MCP_UPLOAD_MAX_BYTES`    | `*-from-url` 上传工具在服务端抓取时的内存上限。超出该大小的文件会转交 wiki 自身的复制上传，不在本服务器缓存。  | `104857600`    |
| `MCP_UPLOAD_DIRS`         | 上传工具允许读取的绝对路径目录，以 `:` 分隔。与 `uploadDirs` 合并生效。                                        | 未设置         |
| `MCP_USER_AGENT`          | 替换所有外部请求的 `User-Agent` 头。不设置时使用内置的 Chrome 桌面版 UA。                                      | 内置 Chrome UA |
| `MCP_TRUSTED_HOSTS`       | 有外发 SSRF 防护：解析到私有或回环地址的目标一律拒绝，此变量列出的主机可豁免。                                 | 未设置         |

## 安全

- **凭证只存在一个文件里。** `session.json` 保存 bilibili 会话，只由 `bwiki-login` 写入。它不会被记入日志，不会通过 MCP 资源暴露，也不会返回给调用方。
- **cookie 是 host-only 的。** 不写入 `Domain` 属性。一旦写入，它会被当作域级 cookie，向任何以 `wiki.biligame.com` 结尾的主机发送。
- **仅限 HTTPS。** 任何请求（包括 SSRF 重定向后的请求）都必须使用 HTTPS。
- **User-Agent 默认采用 Chrome 桌面版。** BWiki 位于腾讯云 EdgeOne 之后，会按 UA 的自动化特征评分，自称 `bwiki-mcp-server/...` 这类字符串更容易被判定为机器人。需要用于统计或联系的目的时，可用 `MCP_USER_AGENT` 覆盖，但我们不建议改成带 bot 字样的形式。
- **限速是有意为之。** 请求串行发出，间隔超过一秒。收到 HTTP 567 或 514 表示已被 EdgeOne 拦截；服务器会暂停三分钟而不是重试，此时你也应当停止调用，而不是想办法绕过。
- **写操作即你的行为。** 服务器以保存的 bilibili 账号身份行事。每条工具调用日志都会标明该账号（形如 `bilibili:<你的 UID>`），使每次写入都可追溯。

## 开发

```bash
pnpm run build              # tsc + esbuild，一步产出 dist/ 与 dist/bundle.cjs
pnpm run build:src          # 只编译 TypeScript 到 dist/
pnpm run bundle             # 只打包为 dist/bundle.cjs
pnpm run clean:dist         # 删除 dist/
pnpm run lint               # oxlint（含 type-aware 检查）
pnpm run lint:fix           # 自动修复 lint 问题
pnpm run format             # oxfmt 格式化
pnpm run format:check       # 检查格式
pnpm run typecheck          # tsc --noEmit（src/ 与 tests/）
pnpm test                   # vitest 单元测试（离线，无需构建）
pnpm run test:watch         # vitest 监视模式
pnpm run test:smoke         # 针对构建产物的 stdio 冒烟测试（需先 build，且需网络）
pnpm run test:boot-session  # 启动期会话校验行为
pnpm run test:writes        # 写路径全流程
```

`tests/` 下的单元测试直接导入 `src/`，不需要先构建，也不读 `config.json`、不联网。`scripts/` 里剩下的是需要真实会话、真实网络或会写真实页面的探针（`probe-liveness.mjs`、`probe-writes.mjs`、`probe-mwn-auth.mjs`、`probe-mwn-compat.mjs`、`probe-referer.mjs`、`probe-cookie-jar.mjs`），属手工工具，不在 `pnpm test` 之内。

`pnpm run test:writes` 会完整走一遍写路径——创建、读回、修改、验证、查历史、删除——在真实 wiki 上留下真实页面。它不在 `pnpm test` 之内，不得无人值守地运行。

发布由 release-please 管理：合并 release PR 后自动创建 tag 与 GitHub Release，并把 `dist/bundle.cjs` 与 `config.example.json` 上传为附件。`pnpm publish` 仍可手动发布到 npm（`prepack` 会自动构建）。

CI 在 Node 22/24/26 上运行 lint、format check、typecheck、build 与 vitest 单元测试。

### 目录结构

- `src/` — 服务入口、工具实现与运行时，由 [ProfessionalWiki/MediaWiki-MCP-Server](https://github.com/ProfessionalWiki/MediaWiki-MCP-Server)（MIT）改编而来。
- `src/bwiki/` — BWiki 专有层：通行证登录、会话拦截、运行期存活校验、请求限速、农场名册、身份判定。
- `src/tools/` — 每个工具一个文件。
- `src/wikis/` — 站点注册与选择，以及负责注入会话 cookie、控制请求节奏的 mwn 提供层。
- `src/runtime/` — 上下文、调度、注册、日志与关闭处理。
- `src/LICENSE` — 上游 Professional Wiki 的 MIT 许可原文。
- `tests/` — vitest 单元测试，直接导入 `src/`，离线运行。
- `scripts/` — 构建脚本与需要真实会话/网络的手工探针。
- `docs/` — 登录方案、mwn 兼容性、会话失效处理的结论记录。
- `.oxlintrc.json` / `.oxfmtrc.json` — lint 与格式化配置。
- `.github/workflows/` — CI 与 release-please 工作流。
- `release-please-config.json` / `.release-please-manifest.json` — release-please 配置与版本基线。

## 许可

MIT。`src/` 的部分代码改编自 [MediaWiki-MCP-Server](https://github.com/ProfessionalWiki/MediaWiki-MCP-Server)，该项目的许可同样是 MIT。
