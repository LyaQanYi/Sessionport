# 安全策略

**中文** | [English](SECURITY.md)

sessionport 处理的是**包含 prompt、源代码、工具输出，有时还有密钥**的文件。
它是本地优先的：适配器从不发起网络请求，也没有遥测。唯一的网络流量来自目标 CLI——
而且是你主动要求它们 resume 会话时才会发生。

## 报告漏洞

安全问题请不要开公开 issue。使用 GitHub 仓库的私密漏洞报告（Security → Report a vulnerability），
或直接联系维护者。请附上最小复现和受影响的适配器/版本。

## 范围

在范围内：由会话内容驱动的路径穿越或任意文件写入、会话文件的不安全反序列化、
可能破坏用户目标端对话的数据丢失 bug、报告或日志中的凭据意外泄露。

不在范围内：agent CLI 自身的安全状况；以及导入会话本来就包含源会话的全部内容这一事实。

## 会话数据的处理方式

- sessionport 默认只读打开会话存储；只有你运行 `push` / `sync` 时才会写入。
- 桌面端注册（Command Code、DSH）会把它修改的索引文件备份到 `.tmp/cc-backups/`。
- 基准 fixtures 提交前必须脱敏；见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- `.sessionport/registry.json` 只存源标识和目标路径——不存消息内容。

## 加固建议

- 把导出的 IR JSON 当作敏感数据：它包含完整对话。
- 提交任何来自会话存储的文件之前，先跑 `git diff`。
- 对生产环境的 home 目录使用 sessionport 时，优先先跑 `--dry-run`。
