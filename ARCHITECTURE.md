# 架构

`index.js` 注册 6 个常驻工具；`controller.js` 处理引用、精简结果、组合发送、增量读取和按需操作；`store.js` 管本地原子存储与超大结果；`operations.js` 保留后端操作实现；`client.js` 负责认证、HTTP RPC 和 WebSocket。

`skill.js` 是同一 bundle 的独立组件，向 DSH skills service 登记随包 Skill provider。list 只返回摘要；get 时读取 skills/dsh-remote-control/SKILL.md 正文。默认工具表仍为六项，Skill 加载由 DSH 当前 preset 的 Skill 工具负责。独立组件使 Skill service 缺失时不阻止工具组件注册。

连接配置和目标实例启动复用 Agent 已有的文件、终端和管理能力；本插件不增加配置文件编辑器或进程启动器。配置文件在 apply 时读取，新增目标须重载插件；认证文件在重新认证时读取。

高级操作采用 dsh_other 的显式 operation + JSON args 字符串。help 返回所选操作的参数说明，execute 调用对应实现；不动态扩大整个 Agent 的工具 registry，不提供任意 RPC。插件不贡献 system prompt section，也不注入所有引用。

## 传输契约

- HTTP POST `/api/<namespace>/<method>`，请求为 `{type:'client-request',rpcId,method,payload:{args:{...}}}`。
- `args` 使用目标生成描述符的 wire 参数名，例如 session/create 的 `{request:{...}}`、session/list 的 `{_request:{}}`。
- 返回必须为同 rpcId 的 server-response。远端失败保留错误 code，避免打印可能包含凭据的任意诊断文本。
- WebSocket `/api/remote.mux` 发送 `{type:'open',streamId,endpoint,payload:{args}}`；接收 item/error/end；结束时发送 cancel 并关闭连接。
- 工作区列表来自 workspace/follow 的首个 baseline；会话读取来自 session/follow 的首个 snapshot，旧历史走 session/page。

## 认证与存储

目标注册在调用方的 connections.json。目标地址与凭据引用分离。客户端用合法启动 token 换取服务端签发的 cookie；不从目标的内部凭据库推导或伪造 cookie。Cookie 写回目标私有 authFile，绑定 origin。实例列表只返回 id 和地址。

## 生命周期

每个目标有一个 DshClient；一次快照使用短期流；`$events` 是插件拥有的持续监听，用于问题和审批的相关标识。监听仅接管显式发送/查看/回应过的会话，其他会话委托下一答复者。Timed question 的 attachWait 流按 remainingMs 维持有时限的前台等待，到期、取消或结束时释放；已继续的问题通过 userQuestions/answer 回答。

插件卸载关闭全部客户端和持续流。工具 exec.signal 传到普通请求与单次等待。结果不确定的写操作由调用方根据会话状态处理，不自动重发。

## 本地状态与交付

LocalStore 使用进程内串行队列、跨进程 lock 文件与临时文件 rename。锁只在证明 owner 进程死亡后回收；损坏的状态不静默重置。引用绑定 instance + origin。会话读取位置共享同一规范 key，保留明确 reset 的 epoch，避免旧暂存结果覆盖新读取位置。

读取固定 throughSeq，向前翻页补齐 afterSeq 后的事件。扫描未完成不确认 cursor。默认只投影 assistant 文本；可显式包含工具/用户内容，原始诊断另走 read_history。

ResultVault 在模型输出前按 JSON 字符长度拦截。超大结果写私有 results/<uuid>.json，state 只记大小、过期时间与确认信息。完整送达或连续分段覆盖全文才确认读取 cursor；按最新 seq 单调推进，reset epoch 不同则忽略旧确认。结果过期/淘汰不确认。

组合发送仅在指定设置时查询/修改设置；普通发送不查询列表或等待生成。设置修改不具备远端原子性。状态查询过滤投影与列表，不返回正文；底层网络仍可能需要读取全部列表，这是未安装被控制端增强插件时的传输限制。

## 扩展

新增操作时核对版本源码的 `@Remote` 声明与生成的 `typert.remote-client.js`，在 extraOperations 添加按需文档与执行分支，并补预算/副作用测试。新增高级功能不默认增加常驻工具或提示词。可选被控制端插件以后通过能力检测增强，基础功能始终可以独立工作。
