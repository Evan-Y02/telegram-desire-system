#!/usr/bin/env python3
import json
import os
import secrets
import sys
import time
import urllib.request
from pathlib import Path

root = Path(os.environ.get("TELEGRAM_DESIRE_CONFIG_DIR", Path.home() / ".config/telegram-desire"))
token = (root / "bot-token").read_text().strip()
code_file = root / "pairing-code"
code = code_file.read_text().strip() if code_file.exists() else secrets.token_urlsafe(8)
code_file.write_text(code + "\n")
code_file.chmod(0o600)

def api(method, params=None):
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + token + "/" + method,
        data=json.dumps(params or {}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=35) as response:
        data = json.load(response)
    if not data.get("ok"):
        raise RuntimeError("Telegram API failed")
    return data["result"]

print("请在 5 分钟内私聊机器人发送：/bind " + code, flush=True)
offset = 0
deadline = time.time() + 300
while time.time() < deadline:
    updates = api("getUpdates", {"offset": offset, "timeout": 20})
    for update in updates:
        message = update.get("message", {})
        if (
            message.get("chat", {}).get("type") == "private"
            and message.get("text", "").strip() == "/bind " + code
        ):
            binding = {
                "chat_id": message["chat"]["id"],
                "user_id": message["from"]["id"],
                "offset": update["update_id"] + 1,
            }
            path = root / "binding.json"
            path.write_text(json.dumps(binding) + "\n")
            path.chmod(0o600)
            code_file.unlink(missing_ok=True)
            api("sendMessage", {"chat_id": binding["chat_id"], "text": "绑定完成，聊天桥可以启动了。"})
            print("BINDING_SAVED=YES", flush=True)
            sys.exit(0)
        offset = update["update_id"] + 1
print("BIND_NOT_COMPLETED", flush=True)
sys.exit(1)
