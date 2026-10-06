# 维护入口

先读 README、ARCHITECTURE、COMPATIBILITY、TESTING。公开接口包括六个工具、按需操作和配置文件格式。新增高级能力默认通过 dsh_other 扩展，并更新帮助与兼容性记录。

- 以当前 DSH 源码、实际导出和生成的 Remote descriptors 核对接口，再实施适配。
- 通信协议改动补 HTTP/WebSocket 行为测试；持续流、计时器和 Skill provider 随插件卸载释放。
- 不自动重试结果不确定的写操作，不把接收回执当成任务完成。
- 保持引用的 origin 绑定、增量读取确认和超大结果分段交付语义。
- 不将令牌、cookie、真实会话或机器专属配置提交到仓库。
- 运行 npm run verify；有显式 DSH 源码时再运行只读契约检查。
- 修改公开行为时更新 CHANGELOG；已发布的版本标签保持不变。
- 安装核验使用 DSH 官方命令及隔离测试数据目录。离线测试、后端验证与真实 Agent 验收分别记录。
- GitHub 上传、创建 Release 或 npm 发布需要维护者明确指令。
