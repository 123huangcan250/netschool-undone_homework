# 依赖与项目结构

运行环境为 Node.js 22.18 及以上。网络请求使用 Node.js 原生 `fetch`、`FormData`、`Blob`，不需要 axios。安装版本固定在 `package-lock.json`，可用 `npm ci` 重现。

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.1 | 官方 MCP 工具、Schema 验证、stdio、测试客户端 |
| `zod` | 4.6.7 | 配置、工具输入输出、持久化回执验证 |
| `cheerio` | 1.2.0 | HTML、表单、CSRF、附件与正文解析 |
| `tough-cookie` | 6.0.0 | 同源会话 Cookie 与服务器轮换处理 |
| `luxon` | 3.7.2 | 显式时区解释及严格时间解析 |
| `fflate` | 0.8.3 | 多文件内存 ZIP 打包；上传前执行大小限制 |
| `typescript` | 锁文件固定 | 严格模式编译 |
| `tsx` | 锁文件固定 | 运行 TypeScript 测试及只读探测脚本 |
| `@types/node`、`@types/luxon` | 锁文件固定 | 开发类型定义 |

测试使用 Node.js 内置 `node:test`、官方 SDK 的 `Client`、`InMemoryTransport`、`StdioClientTransport`，无需单独的测试框架或实际校园账号。只读真实联调用 `scripts/probe.ts`，不会发送提交请求。

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | stdio 入口与生命周期 |
| `src/server.ts`、`src/models.ts` | 四个工具、Schema、结构化结果 |
| `src/config.ts`、`config/*.json` | 配置及可更新协议描述 |
| `src/http.ts` | Cookie、CSRF、同源重定向、排队限速、重试 |
| `src/learn.ts`、`src/parsers.ts` | 接口访问、分页、HTML 解析、去重及时间标准化 |
| `src/files.ts`、`src/submission.ts` | 文件验证、ZIP、提交、持久化回执及核验 |
| `test/*.test.ts` | 网络异常、业务流程、真实 stdio 子进程集成验证 |
| `docs/API.md` | 逆向接口清单及证据等级 |
| `docs/VALIDATION.md` | 已验证范围和待账号验证步骤 |
| `desktop-app/homework_app.pyw` | Windows 常开窗口、本地隐藏、正文展示、每小时调度 |
| `desktop-app/fetch-homework.mjs` | 复用 TypeScript 服务层的只读 JSON-lines 后台读取 |
| `desktop-app/install.ps1` | 创建桌面快捷方式和路径设置，不复制 Cookie |
| `desktop-app/test_homework_app.py` | Python 标准库 unittest、真实 Tk 布局及本地状态测试 |

桌面界面使用 Python 3.11 标准库 `tkinter`、`subprocess`、`threading`、`queue`、`datetime`、`json`、`msvcrt` 等，不需要 pip 依赖。单实例文件锁和安装脚本仅支持 Windows；单独使用 MCP 服务不需要 Python。

协议协商与 stdio 传输由锁文件指定的官方 SDK 负责。依赖自身的许可证保留于安装包；网络学堂公开源码参考与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
