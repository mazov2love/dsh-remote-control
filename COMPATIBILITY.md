# 兼容性

开发依据：DeepSeek Harness 0.2.0-rc.2 源码，Cordis 4.0.4，Node 24.11.1。协议不是本插件自建 API，而是 DSH Web 使用的 Remote 接口。同一 rc 版本号的不同构建可能不同，运行验证是最终依据。

| 契约 | 源码依据 |
| --- | --- |
| token 交换与 Cookie | packages/client/connection/src/browser-auth.ts |
| unary RPC | packages/client/connection/src/client/rpc.ts |
| named args 与路由 | packages/api/gateway/src/index.ts |
| stream mux | packages/api/gateway/src/stream-protocol.ts |
| workspace | packages/api/workspace-controller/src/index.ts、types.ts |
| session | packages/api/session-controller/src/index.ts、types.ts |
| preset | packages/preset/agent-preset-registry/src/index.ts |
| 内容搜索 | packages/api/session-controller/src/list.ts、types.ts |
| 权限选项与修改 | permission-presets/catalog；commands/execute 的 agentId、line、submittedAttachments；官方 UI 使用 /permission |
| timed questions | packages/interaction/user-questions/src/index.ts、types.ts |
| 工具 schema / 生命周期 | packages/core/tools/src/index.ts |

基础代码实现与离线协议测试不等于实际目标版本全部功能可用。运行结果见 TESTING.md。

插件 1.0.0 的基础工具为 6 个，生成 Remote 方法参数核验覆盖 18 项。模型修改走 session/selectModel 并可能保存部署默认；权限修改作用于会话。普通搜索只支持标题/路径等元数据，显式 search_content 才搜索消息正文。

用户报告核心功能已在 DSH 0.2.0-rc.2、自定义 DSH_HOME 与复杂插件环境中正常运行，也已通过对话让 Agent 配置连接及唤起另一实例。此结果不代表所有 preset、所有功能组合或未来版本均兼容。

自带 Skill 依据 packages/skill/skill 的 registerProvider 契约；默认 Web preset 提供 Skill 加载工具。自定义 preset 移除或限制该工具时，Skill 正文不会自动进入上下文；远程六个工具本身不依赖 Skill service。插件版本号与 DSH 版本号独立。

工作区创建是官方 workspace/create 对现有目录的注册；不创建任意远端文件夹。历史增量读取由控制端倒序分页适配，不声称目标有原生 afterSeq 查询接口。超大拦截在控制端发生，不减少已发送的后端载荷。

升级检查：认证入口、cookie 绑定、RPC envelope、named args、stream endpoint、事件 discriminators、工具 schema、DSH bundle metadata。禁止默认启用 ignore-version 或兼容豁免。若接口变化，更新适配与版本范围并重测。
