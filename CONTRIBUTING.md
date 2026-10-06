# 开发和发布

1. 安装 Node 22.19+；使用仓库约定的 npm，执行 `npm ci --ignore-scripts`。
2. 修改前核对当前 DSH 源码。controller/store、操作实现、通信协议和 DSH 注册分别维护；高级能力默认走按需帮助入口。
3. 执行 `npm run verify`，包括语法检查、HTTP/WebSocket 行为测试和安装内容检查。修改依赖时更新 package-lock.json；通常安装使用 npm ci，不重新解析依赖。
4. `npm pack --dry-run` 检查白名单；`.local`、凭据、测试会话不进入发布包。
5. 用 `dsh plugin --profile <profile> add <源码绝对目录>` 或固定 Git 标签的来源安装到专用调用方；自定义数据目录先设置 DSH_HOME。维护者也可以本地打包验证，但用户安装不要求发布包。
6. 应用测试默认从调用方 Agent 实际调用；用户明确自行测试时记录其待验收范围。重点验证非阻塞发送、重复增量读取为空、超大拦截与连续分段，以及待答问题/取消。不能用离线测试替代真实 Agent 使用结论。
7. 更新 TESTING / COMPATIBILITY / CHANGELOG，提交 Git。首个公开版本为 1.0.0，稳定版本使用 v<版本号> 标签；上传仓库后再验证实际 GitHub 来源安装。GitHub Release 和 npm 发布均为可选流程，本项目不内置发布令牌。

CI 配置覆盖 Windows/Linux、Node 22.19 与 24；GitHub 托管检查在仓库上传后运行。package-lock.json 固定本项目开发和测试依赖；用户 profile 的完整依赖树仍由 DSH 的包管理器及 profile 锁文件管理。

PR 说明应列明操作变化、源码版本依据、测试结果和未验证范围。任何 Agent 都可按上述入口继续添加功能，无需隐含对话背景。
