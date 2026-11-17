# 网络学堂接口分析说明

分析日期：2026 年 10 月 23 日。目标源地址：`https://learn.tsinghua.edu.cn`。

本文覆盖本服务使用的全部接口，并区分证据来源。浏览器只读核对及本地 stdio MCP 真实账号读取联调均已通过。2026 年 11 月 17 日另完成两份真实作业的上传与提交状态核验。以下 JSON 为合成结构示例，不泄露真实账号响应；早期实测范围分别记录于 [LIVE_BROWSER_TEST.md](LIVE_BROWSER_TEST.md) 和 [LIVE_MCP_TEST.md](LIVE_MCP_TEST.md)。这里的接口是网络学堂内部接口，非学校发布的稳定开放 API。

## 证据与版本

| 标记 | 含义 | 本次结果 |
| --- | --- | --- |
| A | 本环境直接 HTTP 观察 | 仅未登录入口、重定向与登录页 |
| B | 接口调用方公开源码的一手实现 | 学期、课程、作业、详情、提交、CSRF |
| C | 本项目本地实现及模拟测试 | Schema、限速、重试、分页策略、ZIP、核验、stdio |
| D | 用户登录后的浏览器 DOM、资源清单及部署脚本观察 | 课程页面、三状态列表路径、三类详情页、提交字段及页面限制 |
| E | 本地官方 MCP Client → stdio 服务 → 真实后端 | Cookie 会话、主页 CSRF、学期课程、三个作业列表、三状态详情及有效提交表单读取 |
| U | 待个人账号抓包验证 | 登录后 Cookie 属性、表单附加校验、实际格式上限、原生多附件、提交结果 |

主要参考为 [thu-learn-lib 固定提交](https://github.com/Harry-Chen/thu-learn-lib/tree/07fac46a3cee98fc88cb76faf4344ea67697b274)，提交号 `07fac46a3cee98fc88cb76faf4344ea67697b274`，本地获取时间 `2026-10-23T11:28:58Z`。具体请求路径和表单构造见 [src/urls.ts](https://github.com/Harry-Chen/thu-learn-lib/blob/07fac46a3cee98fc88cb76faf4344ea67697b274/src/urls.ts)，请求及解析见 [src/index.ts](https://github.com/Harry-Chen/thu-learn-lib/blob/07fac46a3cee98fc88cb76faf4344ea67697b274/src/index.ts)，枚举见 [src/types.ts](https://github.com/Harry-Chen/thu-learn-lib/blob/07fac46a3cee98fc88cb76faf4344ea67697b274/src/types.ts)。参考许可保留于项目第三方声明。

接口 JSON 中不同接口的 `result` 类型不同，不能统一解释：学期接口的 `result` 是对象，课程列表使用 `resultList`，作业列表的 `result` 则是成功标记字符串。

## 登录链路与 Cookie 机制

本次对公开入口直接发出未认证 GET，得到以下结果。未保存或展示 Cookie 值，各次请求不依赖个人会话。

| 请求 | 状态 | Location / 页面内容 | Set-Cookie 名称 | 证据 |
| --- | --- | --- | --- | --- |
| `/` | 302 | `/f/redirectByStuOrTeacher` | `JSESSIONID` | A |
| `/f/redirectByStuOrTeacher` | 302 | `/f/login` | `XSRF-TOKEN` | A |
| `/f/login` | 200 | 登录按钮指向下述统一认证入口 | `XSRF-TOKEN`、`JSESSIONID` | A |

登录页按钮指向 `https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/bb5df85216504820be7bba2b0ae1535b/0`。stdio MCP 服务使用网络学堂 Cookie。Windows 桌面程序可在独立浏览器中通过统一认证页面重新登录，验证码由用户处理。

公开调用方实现显示，正常统一认证完成后可取得 roaming ticket，再通过 GET `/b/j_spring_security_thauth_roaming_entry?ticket=...` 建立网络学堂会话，随后访问学生主页读取 CSRF。该 ticket 交换属于 B 级证据，当前账号的实际跳转及 Cookie 属性尚未观测。服务不主动执行该交换，不保存 ticket，只复用用户已经建立的会话。

浏览器通常按域、路径、Secure 等属性管理会话。`id.tsinghua.edu.cn` 的统一认证 Cookie 与 `learn.tsinghua.edu.cn` 的会话不是同一个凭据；在目标站拿到 `JSESSIONID` 也不能单凭名称断言已登录，未登录入口同样会设置此名称。有效性以受保护主页及接口结果判断。

本地配置输入的是浏览器发给网络学堂的 Cookie 请求头值。由于请求头不含原 Cookie 的 Domain、Path、HttpOnly 等属性，本服务将手动 Cookie 初始化为配置源地址的根路径 Cookie，并使用 `tough-cookie` 接收后续同源 `Set-Cookie`。只向配置源地址发请求，外域重定向不会携带凭据跟随。运行中的 Cookie 轮换只保存在内存中。

## 通用请求约定

下表适用于受保护接口，每个具体接口均需有效网络学堂会话。B 级源码使用 `_csrf` 查询参数。本实现同时发送主页指定的 CSRF Header，并保留提交表单隐藏字段；Header 是否为该站必要条件尚待 U 级验证。

| 请求头或字段 | 本地构造 | 说明 |
| --- | --- | --- |
| `Cookie` | 配置值与内存 Cookie jar | 必须属于目标账号的网络学堂会话 |
| `User-Agent` | `userAgent` 配置 | 可使用自己的浏览器 User-Agent |
| `Accept` | JSON、HTML 与通用回退 | 不以该请求头判定业务成功 |
| `Accept-Language` | 按 `language` 配置 | 默认中文 |
| `Referer` | 学生主页；提交时为对应提交页 | 指向同源页面 |
| `Origin` | `https://learn.tsinghua.edu.cn` | 本实现对 POST 发送 |
| `X-Requested-With` | `XMLHttpRequest` | 本实现对 `/b/` 请求发送 |
| `_csrf` 查询参数 | 从学生主页解析，或显式配置 | B 级实现的主要防伪字段 |
| CSRF Header | meta `_csrf_header` 或 `X-CSRF-TOKEN` | 值来自同一会话的页面 token |
| `Content-Type` | POST FormData 由 fetch 自动设置 | `multipart/form-data; boundary=...`，不手写 boundary |

Cookie `XSRF-TOKEN` 的存在不证明其值与页面 `_csrf` 完全相同；本实现不会将二者直接等同。

会话失效包括登录重定向、401、非 CSRF 的 403、可识别的 HTML 登录页及 JSON 登录失效标记，返回 `AUTH_REQUIRED`。403 中明确出现 CSRF 标记时返回 `CSRF_INVALID`，不自动绕过校验。

## 接口总表

相对 URL 均拼接目标源地址；除公开登录入口外均要求 Cookie。

| 用途 | 方法 | URL | 请求体 | 响应 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 学生主页、CSRF | GET | `/f/wlxt/index/course/student/` | 无 | HTML | B、E |
| 当前学期 | GET | `/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester` | 无 | JSON | B、E |
| 学期课程列表 | GET | `/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/{semesterId}/{language}` | 无 | JSON | B、E |
| 未交作业 | POST | `/b/wlxt/kczy/zy/student/zyListWj` | `aoData`，网页使用 URL 编码表单，本适配使用 FormData | JSON | B、D、E |
| 已交未批作业 | POST | `/b/wlxt/kczy/zy/student/zyListYjwg` | 同上 | JSON | B、D、E |
| 已批作业 | POST | `/b/wlxt/kczy/zy/student/zyListYpg` | 同上 | JSON | B、D、E |
| 未交作业详情页 | GET | `/f/wlxt/kczy/zy/student/viewZy` | 无 | HTML | D、E |
| 已交未批详情页 | GET | `/f/wlxt/kczy/zy/student/viewTj` | 无 | HTML | D、E |
| 已批作业详情页 | GET | `/f/wlxt/kczy/zy/student/viewCj` | 无 | HTML | B、D、E |
| 作业描述 | POST | `/b/wlxt/kczy/zy/student/detail` | FormData `id` | JSON | B、E |
| 提交页面 | GET | `/f/wlxt/kczy/zy/student/tijiao` | 无 | HTML 表单 | B、D、E（未截止样本） |
| 上传并提交 | POST | `/b/wlxt/kczy/zy/student/tjzy` | multipart 文件与正文 | JSON | B、D；已完成真实提交核验 |

### 学生主页与 CSRF

GET `/f/wlxt/index/course/student/`，使用通用请求头中的 Cookie，**首次请求尚无 token**。本实现仅此引导请求不加 CSRF。

响应为 HTML。公开实现从页面链接中提取 `_csrf` 查询值；本实现也兼容 meta `_csrf` 和隐藏 input `_csrf`。HTML 登录页不作为有效主页接受。该页面不是课程结构化列表的替代接口。

### 当前学期

GET `/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester?_csrf={token}`。

无业务入参；配置 `semesterId` 非空时跳过此接口。响应的最小已知结构如下，时间和学期字段来自公开解析实现。

```json
{
  "message": "success",
  "result": {
    "id": "SEMESTER_ID",
    "xnxq": "2030-2031-1",
    "kssj": "2030-09-01 00:00:00",
    "jssj": "2031-01-31 23:59:59"
  }
}
```

`id` 为后续课程接口需要的真实学期 ID。不要只根据日期推算 `id` 或假定它必然等于 `xnxq`。

### 课程列表

GET `/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/{semesterId}/{language}?_csrf={token}`。

路径参数 `semesterId` 来自配置或当前学期接口；`language` 为 `zh` 或 `en`。Cookie、CSRF 及通用请求头必需于本适配实现。

```json
{
  "message": "success",
  "resultList": [
    { "wlkcid": "COURSE_ID", "zywkcm": "模拟课程", "kcm": "模拟课程", "ywkcm": "Example course", "jsm": "模拟教师", "jsh": "TEACHER_ID", "kch": "COURSE_NUMBER", "kxh": "1" }
  ]
}
```

| 字段 | 含义 | MCP 映射 |
| --- | --- | --- |
| `wlkcid` | 网络课程实例 ID | `courseId` |
| `zywkcm` | 页面当前语言课程名 | `name`，缺失时回退其他名称 |
| `kcm`、`ywkcm` | 中文、英文课程名 | 名称回退 |
| `jsm` | 任课教师显示名 | `teacher`，缺失为 `null` |
| `jsh`、`kch`、`kxh` | 教师编号、课程编号、课序号 | 文档说明，当前工具不需要 |

### 三个作业状态列表

依次 POST `zyListWj`、`zyListYjwg`、`zyListYpg`，共用下面的请求体，查询均带 `_csrf`。这是只读 POST，可在网络故障后重试。

```text
aoData = [{"name":"wlkcid","value":"COURSE_ID"}]
```

公开实现只发送上述课程筛选，本项目首请求也保持该结构。响应提供总数且首批数量不足时，后续页额外发送 DataTables 风格 `iDisplayStart`、`iDisplayLength`。**分页字段是否被当前学校接口支持属于 U 级验证项**。响应未给出总数时按公开实现处理为完整返回；提供总数却重复同一页时返回 `PROTOCOL_CHANGED`，避免默默遗漏。

```json
{
  "result": "success",
  "object": {
    "aaData": [
      { "xszyid": "STUDENT_HOMEWORK_ID", "zyid": "ASSIGNMENT_ID", "wlkcid": "COURSE_ID", "bt": "实验报告", "jzsj": "2030-11-30 23:59:59", "bjjzsj": "2030-12-02 23:59:59", "scsj": null, "pysj": null, "cj": null, "zywcfs": 1, "zytjfs": 2 }
    ]
  }
}
```

| 字段 | 含义 | 处理规则 |
| --- | --- | --- |
| `xszyid` | 当前学生的作业记录 ID | MCP `homeworkId`，提交必须用它 |
| `zyid` | 教师发布的作业 ID | MCP `assignmentId`，描述接口 `id` 使用它 |
| `wlkcid`、`bt` | 课程 ID、标题 | 校验课程归属，解码 HTML 实体 |
| `jzsj` | 正常截止时间 | `deadline`，使用配置时区转 ISO |
| `bjjzsj`、`sfbj` | 补交截止时间、是否补交标记 | `lateDeadline`；本实现不因存在此值自动启用补交 |
| `zywcfs` | 完成方式 | 公开枚举为 1 个人、2 小组 |
| `zytjfs` | 提交方式 | 公开枚举为 2 网络学堂、0 线下 |
| `scsj` | 此列表公开实现用作提交时间 | `submittedAt`；字段语义以具体接口为准 |
| `cj` | 已有成绩，可为数字或等级 | `score`，不能当作满分 |
| `pysj`、`pynr`、`jsm` | 批阅时间、批语、批阅教师 | 时间映射 `gradedAt`；不作为课程任课教师来源 |
| `sfsc`、`bznr` | 收藏标记、个人笔记 | 本工具不修改这些字段 |

状态以来源接口为准：`zyListWj` → `unsubmitted`，`zyListYjwg` → `submitted`，`zyListYpg` → `graded`。相同课程、相同 `xszyid` 去重，已批状态优先；同名但不同 ID 不合并。

学生列表的 `fbsj`、`kssj`、`zf`、`mf` 未在参考学生解析中证实。适配层可选读取这些候选字段，将其解释为发布时间、开始时间、满分；缺失时返回 `null`。详情页面明确标注的发布时间也可补充。不能将这些候选字段列为已证实必返字段。

### 详情页面与描述 JSON

GET `/f/wlxt/kczy/zy/student/viewCj?wlkcid={courseId}&xszyid={homeworkId}&_csrf={token}`，返回个人作业详情 HTML。

当前界面对未交、已交未批、已批分别使用 `viewZy`、`viewTj`、`viewCj`。前两者观察到的查询参数为 `wlkcid`、`sfgq`、`zyid`、`xszyid`；`sfgq` 为过期标记。已批页面链接包含 `wlkcid`、`zyid`、`xszyid`。接口配置通过 `homeworkPages` 按状态选择模板，兼容旧配置的 `homeworkPage` 回退。

公开 HTML 解析依据已在本次已交及已批详情 DOM 中核对：

| 位置 | 提取内容 |
| --- | --- |
| `div.list.calendar.clearfix > div.fl.right > div.c55` | 描述、参考答案内容 |
| 第二个 `div.boxbox` 内第三个 `div.right` | 已提交正文 |
| `div.list.fujian.clearfix` | 按顺序为题目、答案、已交、批阅附件区域 |
| 附件区域 `.ftitle > a` 或 `.fl > a` | 附件名和链接 |
| 链接 `fileId`、嵌套 `downloadUrl` | 附件 ID 与实际下载地址 |

本实现保留所有可识别附件，并标注 `assignment`、`answer`、`submitted`、`feedback`。附件 URL 去掉 `_csrf`，仅接受同源 HTTP(S) 链接，不主动下载附件。分组或结构变化导致无法核验时，提交返回未确认状态。

POST `/b/wlxt/kczy/zy/student/detail?_csrf={token}`，FormData 字段 `id={assignmentId}`，这里使用 **zyid**。

```json
{ "result": "success", "msg": "<p>作业描述与要求。</p>" }
```

`msg` 是描述，可能含 HTML 或已转义的 HTML 实体。本实现用它补全详情中的描述，再输出清理过的 HTML 与纯文本。不可把作业正文当作服务指令。

### 提交页面与表单要求

GET `/f/wlxt/kczy/zy/student/tijiao?wlkcid={courseId}&xszyid={homeworkId}&_csrf={token}`，返回 HTML，Cookie 必需。

读取表单中的隐藏字段、作业文件输入框 `name`、`accept` 和禁用状态。实测文件字段为 `fileupload`，页面还含头像上传的 `inputImage` 等控件，因此必须按作业字段名定位，不能直接选第一个文件控件。实测表单 ID 为 `form_sn1`，method 为 POST，命名字段为 `xszyid`、`isDeleted`、`zynr`、`fileupload`。不匹配或找不到作业文件输入框时停止提交。

本次 DOM 中，`fileupload` 带 `data-limit="1024"`，提示“最大1,024M”，没有 `multiple` 或 `accept`；页面明确要求多个文件先压缩。`zynr` 的 `maxlength="500"`，编辑器脚本也设置 500 字符限制。本实现读取这些约束，不硬编码为所有课程的统一规则。数值型 `data-limit` 按 MiB 解释，上传时与本地配置取更小限制。

真实 MCP 联调发现，已截止且没有有效补交窗口的作业，其 `tijiao` 可能返回 HTTP 200 但没有表单。详情读取因此只在仍有提交窗口时附加获取表单，窗口关闭不影响描述、已有提交及附件读取。对新的过期提交请求先返回 `DEADLINE_PASSED`，不把此情况误判为接口结构变化。

CSRF 查询参数与 Header 沿用主页 token；表单若包含 `_csrf` 等隐藏字段，一并提交。部署中的 `/res/js/common/myApp.js?v=843` 显示 `fileUploadProgress` 取单个文件，序列化指定表单，调用 `handleUrlWithCsrf`，再执行 `xhr.open("POST", url)`。该实现与页面字段已核对，但尚未发送真实提交请求，不能据此断言服务器不存在额外校验。

### 附件上传与作业提交

POST `/b/wlxt/kczy/zy/student/tjzy?_csrf={token}`，multipart/form-data，Cookie 必需，Referer 为对应提交页，Origin 为网络学堂源地址。

**公开实现的文件上传与提交在同一个请求内完成，没有独立上传 URL 的依据。**

| 表单字段 | 类型 | 含义与本实现 |
| --- | --- | --- |
| `xszyid` | 字符串 | 当前学生作业 ID |
| `zynr` | 字符串 / HTML 正文 | 将纯文本 `remarks` 转义后提交 |
| `fileupload` | 文件 part | 一个本地文件，或多源文件生成的一个 ZIP |
| `isDeleted` | 字符串 | 本实现固定为 `0`；参考实现 `1` 用于删除旧附件 |
| 表单隐藏字段 | 字符串 | 提交页面读取到的附加参数；是否存在须实测 |

参考实现无新附件时会传字符串 `undefined`，本工具要求至少一个有效本地附件，不使用此分支。`isDeleted=0` 不意味着已有附件绝不被替换；新附件提交仍可能覆盖旧附件。

已知成功响应最小结构为：

```json
{ "result": "success" }
```

仅此响应不视为核验完成。服务重新读取三状态列表与详情，比较状态、附件名、正文以及提交时间或附件标识变化，成功后输出 `verified`。附件内容摘要为本地 SHA-256，未实现服务器下载后逐字节比对。

提交网络异常不重放 POST；改用最多配置次数的只读查询核验。结果未知时持久化回执并返回 `SUBMISSION_UNCERTAIN`。本地相同指纹的后续请求先核验已有记录，避免因超时误报而重复覆盖。

本次实测页面只暴露单附件槽位并明确要求多文件压缩。原生多附件字段及独立分块上传接口仍未证实。当前多文件是 ZIP 方案，课程须允许 ZIP；若表单或本地白名单不允许，返回格式错误。

## MCP 协议输出

使用 [官方 stdio 传输约定](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 和 [工具定义规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。官方 SDK 负责初始化、协议协商、`tools/list`、`tools/call` 和 Schema 验证。标准输出只有 MCP 消息。

所有工具定义完整输入与输出 Schema、名称、描述、title、annotations。读取工具标记只读和幂等；提交工具标记可修改已有内容、非幂等。输出模型的全部字段以 `src/models.ts` 为准，工具可通过标准 `tools/list` 自动发现。

重要结构如下：

| 字段 | 含义 |
| --- | --- |
| `publishedAt`、`startAt`、`deadline`、`lateDeadline`、`submittedAt`、`gradedAt` | ISO 8601 UTC 或 `null` |
| `timeNodes` | 所有可识别完整日期、时间节点及原文；无法解释时 `iso:null` |
| `remainingSeconds` | 到正常截止时间的整秒差，可为负数 |
| `overdue` | 是否已到正常截止时间，不等同于未交 |
| `warnings` | 缺失或无法解析字段说明 |
| `requirements.acceptedExtensions` | 表单 `accept` 原始约束，可能含扩展名或 MIME |
| `requirements.acceptsSource` | `form` 或 `unknown`，避免假装已经掌握课程限制 |
| `requirements.maxFileBytes`、`maxRemarksLength` | 表单给出的附件字节上限及备注字符上限；缺失为 `null` |

真实账号抓包、验收和更新协议配置的步骤见 [VALIDATION.md](VALIDATION.md)。
