# Telegram Desire System

把 Codex CLI 接到 Telegram，并在 VPS 上增加一个可持久化、可检查、可停用的“内在驱动”层。

这是一套工程化模拟系统，不声称模型具有生理欲望或意识。驱动值只用于决定何时唤醒、做什么、如何记录和何时冷却。成人/亲密内容只应在成年人、自愿、私密的场景中启用。

## 包含什么

- Telegram 私聊桥：长轮询、会话续接、图片输入、长消息分段、失败重试。
- 时间感：每轮注入本地时间、消息时间、距上次消息/互动的间隔，不修改 VPS 系统时区。
- 对话刺激：模型用结构化 JSON 给出各驱动的即时变化，写入独立 inbox。
- 心跳引擎：被动变化、昼夜因素、阈值、冷却、失败不结算、一次通常一个行动。
- 自主行动：联系用户、solo/反思/探索/责任札记、可选外部社交。
- 私人面板：一次性 Telegram 登录链接，浏览器会话可设 30 天；时间线和札记折叠展示。
- 图片清理：图片默认保留 48 小时，正在处理的文件不会删除。
- Emoji reaction：只允许对当前绑定私聊里最近验证过的消息贴反应。
- 可选长期记忆：在 Codex 压缩前把增量会话归档到你自己的记忆 MCP。

## 安全默认值

示例配置默认：

- `observeOnly=true`：先观察，不执行自主行动。
- 外部社交写入关闭。
- 禁止私聊陌生人、消费、改账号、泄露隐私。
- Token、绑定信息、聊天状态、札记、面板令牌和图片全部在 `.gitignore` 中。
- Bot 只响应绑定的私聊 `chat_id + user_id`。
- Codex 聊天回合默认只读、无审批写入。

不要把生产目录整体提交；尤其不要提交 `bot-token`、`binding.json`、`chat-state.json`、日志、图片、札记或 MCP 凭据。

## 要求

- Linux VPS，推荐 Ubuntu 24.04
- Python 3.11+
- Node.js 22+
- Codex CLI 已登录
- systemd user services
- Telegram Bot Token
- 可选：Caddy + 域名（私人面板）
- 可选：GitHub、长期记忆和社交 MCP

## 快速安装

```bash
git clone https://github.com/YOUR_NAME/telegram-desire-system.git
cd telegram-desire-system
chmod +x scripts/install.sh
./scripts/install.sh /absolute/path/to/your/companion-workspace https://panel.example.com/desire/
```

保存 Token（不要把 Token 发到聊天里）：

```bash
install -m 600 /dev/null ~/.config/telegram-desire/bot-token
nano ~/.config/telegram-desire/bot-token
TELEGRAM_DESIRE_CONFIG_DIR="$HOME/.config/telegram-desire" \
  python3 telegram-bridge/bind.py
```

绑定后，先运行测试：

```bash
cd desire-system
npm test
python3 -m py_compile ../telegram-bridge/*.py
node bin/heartbeat.mjs
```

启动：

```bash
systemctl --user enable --now telegram-desire-bridge.service
systemctl --user enable --now telegram-desire-dashboard.service
systemctl --user enable --now telegram-desire-heartbeat.timer
loginctl enable-linger "$USER"
```

先观察至少一天。确认时间、阈值和记录符合预期后，才把
`desire-system/config/default.json` 的 `observeOnly` 改为 `false`。

## 面板

面板只监听 `127.0.0.1:8793`。用反向代理公开时请启用 HTTPS。参考
`deploy/Caddyfile.example`，不要直接暴露 8793。

在 Telegram 私聊发送 `/panel` 会生成十分钟有效、仅可使用一次的登录链接。
链接验证页不会立刻消耗令牌，点击“进入”后才建立浏览器会话。

## Reaction MCP

把下面的 MCP server 加到 Codex 配置（路径换成你的仓库路径）：

```toml
[mcp_servers.telegram_reactions]
command = "python3"
args = ["/absolute/path/telegram-desire-system/telegram-bridge/telegram_reaction_mcp.py"]
env = { TELEGRAM_DESIRE_CONFIG_DIR = "/home/YOU/.config/telegram-desire" }
```

聊天桥只把本轮真实的 `message_id` 交给模型；MCP 还会再次检查它是否来自最近验证过的绑定私聊。

## 长期记忆与压缩

不同长期记忆服务的 MCP 名称和工具参数不同，因此本仓库不内置任何人的服务器名、授权口令或凭据。接入时遵循：

1. 只归档上次成功位置之后的新增会话。
2. 先写入，再读回核验；核验失败不推进 checkpoint。
3. 压缩后只注入“已核验的索引”，不把整库塞回上下文。
4. 归档失败不得阻塞 Telegram 正常聊天。
5. 后台重试必须幂等，避免重复记忆。

把你的归档脚本绝对路径写入 `settings.json.memoryArchiveScript`；脚本需支持：
`preflight --session ID --transcript FILE --budget SECONDS` 和
`index --session ID` 两个子命令。留空即关闭。

## 自定义

主要参数在 `desire-system/config/default.json`：

- `initial`：初值。
- `thresholds`：行动门槛。
- `passive`：随时间变化。
- `actionCountWeights`：一次醒来做 1/2/3 件事的概率；3 只是硬上限。
- `autonomy.*CooldownMinutes`：全局、联系、solo 冷却。
- `social.permissions`：外部社交权限边界。

身份与新会话提示在 `~/.config/telegram-desire/settings.json`。不要把私密身份文件放进公开仓库。

## 数据位置

默认所有运行数据在：

- `~/.config/telegram-desire`：Token、绑定、桥状态。
- `~/.local/share/telegram-desire`：状态、时间线、经历、札记、面板会话。
- `~/.codex/sessions`：Codex CLI 自己的会话记录。

它们占用的是硬盘，不是持续占满内存。运行进程只在工作时使用 RAM。

## 测试和故障排查

```bash
npm --prefix desire-system test
systemctl --user status telegram-desire-bridge.service
journalctl --user -u telegram-desire-bridge.service -n 100 --no-pager
systemctl --user start telegram-desire-heartbeat.service
curl http://127.0.0.1:8793/healthz
```

若模型额度不足，聊天回合会失败并提示检查；欲望行动不结算，心跳定时器继续。
若 Telegram 不通，先检查 VPS 到 `api.telegram.org` 的网络，而不是反复撤销 Token。

## 许可证

MIT。欢迎 fork，但请自行负责 Bot Token、模型额度、MCP 权限和成人内容边界。
