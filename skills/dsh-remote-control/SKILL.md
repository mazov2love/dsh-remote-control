---
name: dsh-remote-control
description: 使用另一个 DSH 实例，配置连接、启动目标实例、创建会话、发送消息并按需查看状态或回复。
---

# 使用另一个 DSH

本插件提供六个远程操作入口。目标 DSH 无需安装本插件。配置文件操作和启动程序使用当前 Agent 已有的文件、终端或 DSH 管理能力；这些通用能力不是远程插件新增的工具。

## 快速连接

用户可告知目标端口与令牌，或提供包含 `?token=...` 的完整启动链接。先通过 `dsh_other action=execute operation=instances args="{}"` 查看已配置目标，避免重复配置。

1. 确认调用方实际 `DSH_HOME`。未设置时默认是用户目录下 `.dsh`；它不是当前工作区的 `.dsh`。同时检查插件是否显式设置 `config.connectionsFile` 或 `config.targets`：显式 targets 优先于连接文件，必须修改真正生效的配置来源。
2. 将启动链接拆成纯 origin（例如 `http://127.0.0.1:3080`）和 token。目标 `url` 只存 origin，不包含 token、路径、查询或片段。仅提供端口且目标在本机时使用 loopback 地址。
3. 默认连接配置位于 `<DSH_HOME>/remote-control/connections.json`，形状为 `{"targets":[{"id":"technical","url":"http://127.0.0.1:3080","authFile":"<绝对路径>/technical.auth.json"}]}`。id 允许字母、数字、下划线和连字符。保留其他目标及用户已有配置。
4. 私有认证文件形状为 `{"origin":"http://127.0.0.1:3080","token":"用户提供的令牌"}`。写入 UTF-8 JSON，放在调用方 DSH 的私有数据目录。更新失效令牌时不要保留旧 cookie。也可使用已有 `tokenEnv` 配置，但环境变量必须对调用方 DSH 进程生效。
5. 新增目标或改变连接配置后，用当前 DSH 已有的管理能力重载插件；没有可用的重载能力时，告知需要重启调用方。只更改认证文件时，客户端会在重新认证时读取它。不要把“文件已保存”当成“当前插件已经加载新目标”。
6. 再查询 instances，随后通过 `dsh_other action=execute operation=workspaces`，args 使用 `{"instance":"technical","limit":1}`，验证实际认证和后端访问。空工作区列表也可以表示连接成功；只列 instances 不能证明认证成功。

不要在最终回复、公开示例或日志中重复令牌和 cookie。用户通过对话提供的令牌仍属于该会话历史，插件不能抹去此前的消息。

## 用户要求启动另一个实例

使用已有终端能力和该安装的 DSH 公共 CLI。先核对实际启动命令、目标 profile、DSH_HOME 和端口，保留目标现有插件及配置；源码安装通常从源码目录使用 `pnpm dsh web`，独立安装使用其实际 `dsh web` 命令。不要修改 DSH 核心。

Windows 后台启动应使用隐藏窗口。启动日志可能包含令牌，私下读取当前启动链接用于上面的连接配置，回复只报告地址和启动结果。端口已占用时确认已有服务，不任意终止进程。缺少启动、文件写入或插件管理能力时，准确说明所缺步骤。

## 日常操作

- `dsh_create`：创建远程会话，或将已有目录注册为工作区。可记录 name、purpose、notes，返回可复用的 ref。目标目录不存在时，此接口不会替你创建远端目录。
- `dsh_refs`：查询和维护本地引用。列表精简并分页，get 才返回完整注释。已有 ref 时可以直接使用，无需重复列出工作区和会话。
- `dsh_send`：发送消息并立即返回接收回执，远端独立继续工作。可显式附带模型或权限设置；设置失败时不发送。accepted=true 是接收成功，accepted=unknown 要先核对远端状态再决定重试。
- `dsh_status`：默认只查状态；view=new 读取新增回复；view=final 预览最新文本且不消耗读取位置。idle 不等于某条请求成功，final 也不保证任务完成。
- `dsh_search`：默认搜索保存的引用；scope=sessions/workspaces 搜远端元数据，支持分页。
- `dsh_other`：先用 action=help 或 list 查询按需操作；execute 的 args 必须是 JSON 对象字符串。操作包含目录、历史、显式等待、取消、问题答复、模型/权限和超大结果读取。

发送无需附带等待或读取回复。什么时候查状态、什么时候读取内容，由当前需要决定。wait 只在明确需要等待时使用；没有自动完成通知或唤醒能力。

返回 oversized 时，原文尚未进入上下文，读取位置也未推进。先看大小信息，再决定是否使用 operation=result 分段读取或扩大预算。按 nextOffset 连续读取，全部送达后才确认位置；不要为了让一次调用“完整”就默认拉取全部内容。

引用绑定目标 origin；同一目标 id 改成其他地址后，不要沿用旧会话引用。默认连接配置、本地引用和读取状态保存在调用方 DSH_HOME，卸载插件不会自动删除这些数据。
