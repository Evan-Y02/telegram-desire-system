#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
workspace="${1:-$HOME/companion-workspace}"
panel_url="${2:-https://panel.example.com/desire/}"
config_dir="$HOME/.config/telegram-desire"
data_dir="$HOME/.local/share/telegram-desire"
units_dir="$HOME/.config/systemd/user"

for command in python3 node codex systemctl; do
  command -v "$command" >/dev/null || { echo "缺少依赖: $command" >&2; exit 1; }
done
test -d "$workspace" || { echo "工作区不存在: $workspace" >&2; exit 1; }

install -d -m 700 "$config_dir" "$data_dir" "$units_dir"
python3 - "$root" "$workspace" "$panel_url" "$HOME" <<'PY'
import sys
from pathlib import Path

repo = Path(sys.argv[1])
workspace = sys.argv[2]
panel_url = sys.argv[3]
home = sys.argv[4]

def render(source, target):
    text = Path(source).read_text()
    text = text.replace("__HOME__", home).replace("__WORKSPACE__", workspace)
    text = text.replace("__REPO__", str(repo)).replace("https://panel.example.com/desire/", panel_url)
    Path(target).write_text(text)

render(repo / "telegram-bridge/settings.example.json", Path(home) / ".config/telegram-desire/settings.json")
render(repo / "telegram-bridge/model.example.json", Path(home) / ".config/telegram-desire/model.json")
render(repo / "telegram-bridge/auto-new.example.json", Path(home) / ".config/telegram-desire/auto-new.json")
render(repo / "telegram-bridge/reply-schema.json", Path(home) / ".config/telegram-desire/reply-schema.json")
render(repo / "desire-system/config/default.example.json", repo / "desire-system/config/default.json")
for name in (
    "telegram-desire-heartbeat.service", "telegram-desire-heartbeat.timer",
    "telegram-desire-dashboard.service", "telegram-desire-bridge.service",
):
    render(repo / "systemd" / name, Path(home) / ".config/systemd/user" / name)
PY
chmod 600 "$config_dir"/*.json
systemctl --user daemon-reload

echo "安装模板完成。"
echo "下一步："
echo "1. 把 BotFather Token 写入 $config_dir/bot-token，并 chmod 600。"
echo "2. 运行 TELEGRAM_DESIRE_CONFIG_DIR=$config_dir python3 $root/telegram-bridge/bind.py。"
echo "3. 检查 settings.json 和 desire-system/config/default.json；先保留 observeOnly=true。"
echo "4. 启动 bridge/dashboard/timer，观察稳定后再把 observeOnly 改为 false。"
