# 清华大学网络学堂 MCP 服务

TypeScript 本地 stdio 服务，使用官方 `@modelcontextprotocol/sdk`、Node.js `fetch` 和 `cheerio`。提供课程列表、作业列表、详情和附件提交四个工具。只接收用户在浏览器正常登录后取得的网络学堂 Cookie。

**验证范围：代码构建、39 项 Node.js 本地测试及真实账号的 stdio MCP 只读联调已通过。** 读取了本学期 11 门课程、抽查课程全部 5 项作业，并分别验证未交、已交未批、已批各一项详情、附件和截止时间。真实上传与提交尚未执行。[接口文档](API.md)、[浏览器实测记录](LIVE_BROWSER_TEST.md) 和 [MCP 实测记录](LIVE_MCP_TEST.md) 区分各自验证范围。

## 安装与启动

需要 Node.js 22.18 或更高版本及 npm。项目内已有 `package-lock.json`，使用锁定版本安装。

```powershell
cd "E:\path\to\thu-learn-mcp-server"
npm ci
if (!(Test-Path -LiteralPath "config/local.json")) {
    Copy-Item -LiteralPath "config/example.json" -Destination "config/local.json"
}
npm run build
node dist/index.js --config "E:\path\to\thu-learn-mcp-server\config\local.json"
```

若 `local.json` 已存在，请直接编辑，避免覆盖已有 Cookie。启动后等待客户端发送 MCP 消息，终端没有普通欢迎输出属于正常现象。`stdout` 仅用于协议，启动错误写入 `stderr`。空 Cookie 允许初始化及工具发现，读取工具返回 `AUTH_REQUIRED`。

项目使用锁文件指定的 SDK v1.32.1，协议协商与工具注册由官方 SDK 处理。[官方版本说明](https://ts.sdk.modelcontextprotocol.io/)

## 获取并配置 Cookie

1. 在自己的浏览器访问 `https://learn.tsinghua.edu.cn/`，正常完成清华统一身份认证，进入学生课程主页。
2. 打开开发者工具 → Network，刷新主页，选择一个目标域为 **learn.tsinghua.edu.cn** 的正常课程请求。
3. 在 Request Headers 中复制 `Cookie` 的完整值，仅复制 `name=value; name2=value2`。不要复制 `Cookie:` 前缀、响应 `Set-Cookie`、其他域 Cookie 或整个 cURL 命令。
4. 在本地编辑 `config/local.json` 的 `cookie` 字段。`semesterId` 留为 `null` 时查询服务器当前学期，也可以填 Network 中真实出现的学期 ID。`csrfToken` 建议为 `null`，由服务使用该会话从学生主页读取。
5. 会话过期时重新登录、更新本地配置并重启服务。独立 MCP 服务处理内存中的同源 `Set-Cookie` 轮换，不会填写密码或自动提交认证表单。桌面模式另行支持独立浏览器 Cookie 同步，并会保存验证有效的轮换 Cookie；从桌面更新后，MCP 服务需重启以读取配置。

不要把 Cookie 放进聊天、Git、命令行或问题报告。`local.json`、HAR 和提交回执已加入 `.gitignore`；Windows 上本地配置的访问权限取决于目录 ACL。统一认证域的登录 Cookie 不能代替网络学堂会话 Cookie。

## 配置说明

完整字段见 [config/example.json](../config/example.json)。所有相对配置路径均相对于 `local.json` 所在目录。

| 字段 | 作用 |
| --- | --- |
| `baseUrl` | 默认网络学堂 HTTPS 源地址；测试允许 loopback HTTP |
| `cookie` | 网络学堂请求 Cookie 原值 |
| `semesterId` | `null` 表示查询当前学期，否则使用指定 ID |
| `language`、`timezone` | 页面语言及无时区时间的解释时区，默认 `zh`、`Asia/Shanghai` |
| `requestIntervalMs` | 每个服务进程所有请求、重定向和重试共用队列，至少 1000 毫秒 |
| `requestTimeoutMs`、`retryCount` | 单次超时；只读操作异常后最多重试两次 |
| `pageSize`、`maxPages` | 上游分页设置；不能确认完整性时返回错误 |
| `protocolFile` | URL 模板、提交字段、HTML 选择器，默认 `protocol.json` |
| `submission.allowedRoots` | 可上传文件目录，支持多个绝对路径或相对路径；验证真实路径及符号链接 |
| `submission.allowedExtensions` | 本地扩展名白名单；空数组表示只按课程表单与大小限制检查 |
| `submission.maxFileBytes`、`maxTotalBytes`、`maxFiles` | 单个上传文件、源文件总大小、文件数量上限，单位为字节 |
| `submission.multiFileMode`、`archiveName` | `zip` 打包多文件；`reject` 禁用多文件 |
| `submission.allowUnknownDeadline` | 默认 `false`，无法解析截止时间时停止提交 |
| `submission.allowLateSubmission` | 默认 `false`；启用后也必须处于有效补交截止时间内 |
| `submission.verificationAttempts` | 提交后最多查询核验次数 |
| `submission.receiptFile` | 本地提交回执与排他锁的位置 |

默认允许目录为项目的 `submissions`，可以把待交文件放入其中；也可以把自己常用的作业目录加入 `allowedRoots`。服务不读取目录中的文件，只有调用提交工具时才读取明确指定的文件。

`userAgent` 可填自己的浏览器 User-Agent；Cookie、Origin、Referer、语言、AJAX 标识、CSRF 字段及 multipart 边界由客户端构造。Node.js 不会伪装浏览器 TLS 指纹；不要硬编码 `Content-Length` 或 multipart `Content-Type`。

## Claude Code 接入

先完成安装与构建，再使用绝对路径注册。以下是一条命令，路径按实际位置修改。

```powershell
claude mcp add --transport stdio --scope user thu-learn -- node "E:\path\to\thu-learn-mcp-server\dist\index.js" --config "E:\path\to\thu-learn-mcp-server\config\local.json"
```

在 Claude Code 中运行 `/mcp` 检查工具连接。[Claude Code 官方 stdio 接入文档](https://code.claude.com/docs/en/mcp)

其他支持 stdio 的客户端可以使用以下 `mcpServers` 配置。客户端直接启动 `node`，避免 npm 启动提示混入协议流。

```json
{
  "mcpServers": {
    "thu-learn": {
      "command": "node",
      "args": [
        "E:/path/to/thu-learn-mcp-server/dist/index.js",
        "--config",
        "E:/path/to/thu-learn-mcp-server/config/local.json"
      ]
    }
  }
}
```

## 工具与示例

所有成功结果提供 `content` 和 `structuredContent`，内容为 `{"ok":true,"data":...}`。业务错误为 `isError:true`，内容为 `{"ok":false,"error":{"code","message","retryable","remediation"}}`。参数验证错误由官方 SDK 返回工具错误。

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `get_course_list` | 无 | 当前或配置学期、课程 ID、名称、教师 |
| `get_homework_list` | `courseId` | 合并三个状态列表；ISO 时间、剩余秒数、状态、成绩 |
| `get_homework_detail` | `homeworkId` | 描述、附件、提交说明、已提交内容、识别到的时间节点 |
| `submit_homework` | `homeworkId`、`filePath` 或 `filePaths`、可选 `remarks` | 核验结果、附件名、源文件名、SHA-256、本地回执状态 |

示例 ID 是占位符，须替换为前一步工具返回的值。`homeworkId` 使用学生作业 ID `xszyid`，不是教师作业 ID `zyid`。

```json
{"name":"get_course_list","arguments":{}}
{"name":"get_homework_list","arguments":{"courseId":"COURSE_ID"}}
{"name":"get_homework_detail","arguments":{"homeworkId":"STUDENT_HOMEWORK_ID"}}
{"name":"submit_homework","arguments":{"homeworkId":"STUDENT_HOMEWORK_ID","filePath":"E:/coursework/report.pdf","remarks":"实验报告已完成。"}}
{"name":"submit_homework","arguments":{"homeworkId":"STUDENT_HOMEWORK_ID","filePaths":["E:/coursework/report.pdf","E:/coursework/source.py"],"remarks":"报告及源代码。"}}
```

可以直接向客户端提出：“列出本学期未提交且三天内截止的作业，并显示课程和截止时间。”确认具体作业和文件后，再请求提交。提交工具会替换该作业已有附件及正文。

普通作业、实验报告、论文、测验通过标题与描述关键词识别，`typeSource` 固定为 `heuristic`，不表示学校官方类别。没有专门实现在线测验答题接口。缺失发布时间、满分或无法解析的时间返回 `null`，不猜测数值。`score` 为已有成绩，`maxScore` 为可用的满分字段，两者不混用。

截止时间以学校所在时区解释后转为 UTC ISO 8601。`remainingSeconds` 可为负数，`overdue` 只代表是否已到截止时间，与是否已提交独立。正文提取包含完整日期的时间节点，保留原文；自然语言中的“下周五”等表达需要人工理解。

已截止作业仍可读取详情及已交附件。正常提交和补交窗口都关闭时，不再尝试读取已关闭的提交表单，相关表单限制保持未知并附加说明；已有提交回执也可在截止后只读核验。

### 多文件与提交核验

公开提交实现只有一个 `fileupload` 附件槽位，因此服务会将多文件打包为一个 ZIP 后提交。课程表单若仅允许 PDF，服务会拒绝 ZIP；不会虚构独立上传接口或循环提交多个文件覆盖前一个。若学校原生支持多附件，需要用真实抓包更新适配层。

格式检查依据提交表单 `accept` 与本地白名单。表单未公布格式或大小上限时，相应值保持未知，仍执行本地大小限制；无法保证代替服务器或教师的所有要求。服务检查扩展名及常见 MIME 对应关系，不做文件内容的格式鉴定。

实测表单使用 `fileupload`，页面另有头像上传控件，因此解析器按字段名选择作业附件。`data-limit` 用于提取附件上限，`zynr` 的 `maxlength` 用于提取备注上限；本次页面分别为 1,024 MiB 与 500 字符。配置中的本地大小上限仍取更严格值，默认不会因为网站允许较大附件而自动放宽。

只读请求遇到网络异常或可重试 HTTP 状态时重试两次。**提交 POST 不盲目重试**：超时后执行只读核验。核验比较提交状态、附件名、正文，并要求本次提交标记相对提交前变化；无法确认则返回 `SUBMISSION_UNCERTAIN`。该核验不等同于服务器附件字节校验；返回的 SHA-256 是本地上传字节的摘要。

本地回执可在进程重启后阻止相同请求重复发送。排他锁防止多个进程同时提交。遇到未确认回执或残留 `.lock`，先在浏览器核对真实结果，再按提示处理本地记录；不要直接删除记录后反复重试。

## 桌面作业列表

新增独立的“作业列表”桌面窗口，每小时读取当前学期所有课程的未提交作业，按剩余时间升序排列，最小化后保持运行。窗口使用 Python 标准库，读取层复用本项目的认证、限速与重试。安装和使用见 [desktop-app/README.md](../desktop-app/README.md)。

## 验证与排障

```powershell
npm run check
npm run probe -- --config "E:\path\to\config\local.json"
npm run probe -- --config "E:\path\to\config\local.json" --course COURSE_ID
npm run test:live -- --config "E:\path\to\config\local.json" --course COURSE_ID
```

`check` 编译并运行模拟测试；测试使用合成课程、临时文件和本地 HTTP 服务，不连接真实账号、不上传真实作业。`probe` 直接检查只读接口；`test:live` 启动编译后的 stdio 服务，使用官方 MCP Client 调用三个读取工具，按未交、已交、已批各抽取一项详情，并在 `.state/live-validation.json` 保存不含姓名、课程 ID、Cookie 或作业正文的摘要。两个命令均不调用提交工具。没有本地 Cookie 时返回 `AUTH_REQUIRED`，浏览器登录态不会自动传给 Node.js 进程。

`AUTH_REQUIRED` 表示缺少、过期或无权使用会话；`CSRF_INVALID` 表示令牌与会话不匹配；`PROTOCOL_CHANGED` 表示接口或 HTML 不符合已知结构。冷启动直接查详情时，服务需逐课程定位作业，课程较多时调用较慢，可先拉取对应课程作业列表。

源代码位于 `src`，测试位于 `test`。完整 MCP 工具定义已导出至 [docs/tools.json](tools.json)，可通过 `npm run export-tools` 重新生成。依赖与实现选择见 [DEPENDENCIES.md](../DEPENDENCIES.md)，验证证据与真实账号验收步骤见 [docs/VALIDATION.md](VALIDATION.md)，合成数据评估集见 [evaluations/README.md](../evaluations/README.md)。
