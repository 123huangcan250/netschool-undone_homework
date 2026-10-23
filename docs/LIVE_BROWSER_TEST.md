# 登录后浏览器只读测试记录

观察日期：2026 年 10 月 23 日。用户在内置浏览器完成统一身份认证，随后由自动化读取页面及 DOM。本文不记录姓名、学号、Cookie、CSRF token、学生作业 ID、已交文件名或成绩。

## 实测结果

| 项目 | 观察结果 |
| --- | --- |
| 登录 | 成功进入 `/f/wlxt/index/course/student/` |
| 当前页面学期 | 2026-2027 秋季学期 |
| 课程列表 | 显示 11 门课程，可读取名称、教师及链接中的课程实例 ID |
| 抽查课程作业 | 未提交 1 项，已提交未批改 1 项，已批改 3 项，合计 5 项 |
| 列表接口资源 | 观察到 `zyListWj`、`zyListYjwg`、`zyListYpg` |
| 请求方式依据 | 当前部署 `dataTablePlugin.js?v=843` 使用 POST，参数 `aoData=JSON.stringify(aoData)`，成功响应读 `data.object` |
| 三类详情路径 | 未交 `viewZy`，已交未批 `viewTj`，已批 `viewCj` |
| 生效日期 | 当前页面脚本使用 `kssj`；不将其错误映射为发布时间 |
| 已交详情 | 两个 `boxbox`，第二块为本人提交；第三个 `div.right` 为上交正文 |
| 已批详情 | 三个 `boxbox`；附件区域依次为题目、答案、已交、评语 |
| 提交页面 | `form_sn1`，method POST，字段 `xszyid`、`isDeleted`、`zynr`、`fileupload` |
| 备注限制 | textarea 的 `maxlength=500`，CKEditor 脚本 `maxCharCount=500` |
| 附件限制 | `data-limit=1024`，页面提示最大 1,024M；本地解析为 1,073,741,824 字节，仍与本地限制取更小值 |
| 多文件 | 文件输入框没有 `multiple`，页面明确要求多个文件先压缩为一个文件 |
| 附件格式 | 此样本输入框未给出 `accept`，教师正文中的格式要求仍需遵守 |
| 上传方式依据 | `myApp.js?v=843` 的 `fileUploadProgress` 将一个文件和序列化表单加入 FormData，附加 CSRF 后 POST `tjzy` |

## 根据观察修正的实现

1. 按作业状态选择 `viewZy`、`viewTj`、`viewCj`，保留旧协议配置的回退。
2. 按 `name=fileupload` 选择作业控件。页面更前面还有头像上传控件，直接取首个 `input[type=file]` 会误选。
3. 提取 `data-limit` 与正文 `maxlength`，超长备注在发送提交请求前拒绝。
4. 英文标题中的 `Experiment` 纳入实验报告的启发式分类。
5. 加入匿名化实测结构回归样本；浏览器核对阶段通过 34 项本地测试，后续真实接口联调修正后共 36 项通过。

## 本次边界与剩余验证

本次只打开页面和读取已加载的 DOM、资源清单、公共 JavaScript，没有选择附件、上传文件或点击最终“提交”。原有作业没有被覆盖。

本记录生成时尚未配置本地 Cookie。之后用户完成手动配置，已成功运行本地 MCP 到真实后端的只读联调，结果见 [LIVE_MCP_TEST.md](LIVE_MCP_TEST.md)。浏览器的已登录会话不会自动成为 Node.js 的 Cookie 配置。可复核命令为：

```powershell
npm run test:live -- --config config/local.json --course COURSE_ID
```

该命令启动真实 stdio 进程，使用官方 MCP Client 调用三个只读工具，保存匿名计数及核验结果，不调用 `submit_homework`。真实提交测试需要另行明确指定作业及文件。

## 可复核公共脚本

- `https://learn.tsinghua.edu.cn/res/js/common/myApp.js?v=843`
- `https://learn.tsinghua.edu.cn/res/js/common/dataTablePlugin.js?v=843`
- `https://learn.tsinghua.edu.cn/res/app/wlxt/js/common.js?v=843`

这些公共脚本用于核对前端构造方式，不等同于已经发送并验证过全部后端请求。脱敏结构摘要见 [evidence/authenticated-browser.json](evidence/authenticated-browser.json)。
