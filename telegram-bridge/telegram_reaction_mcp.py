import fcntl
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(os.environ.get("TELEGRAM_DESIRE_CONFIG_DIR", Path.home() / ".config/telegram-desire"))
EMOJIS = ["❤", "❤️", "👍", "🥰", "😁", "🤔", "😢", "🎉", "🔥", "😘", "👀", "🤗"]

def record_target(message_id):
    if type(message_id) is not int or message_id < 1:
        raise ValueError("invalid message identifier")
    os.umask(0o077)
    with (ROOT / "reaction-targets.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = ROOT / "reaction-targets.json"
        targets = json.loads(path.read_text()) if path.exists() else {}
        now = time.time()
        targets = {k: v for k, v in targets.items() if now - v < 86400}
        targets[str(message_id)] = now
        targets = dict(sorted(targets.items(), key=lambda pair: pair[1])[-100:])
        temp = ROOT / "reaction-targets.tmp"
        temp.write_text(json.dumps(targets))
        temp.replace(path)
        path.chmod(0o600)

def set_reaction(arguments):
    message_id = arguments.get("message_id")
    emoji = arguments.get("emoji")
    big = arguments.get("is_big", False)
    if type(message_id) is not int or type(big) is not bool:
        raise ValueError("message_id must be an integer and is_big a boolean")
    if emoji == "❤":
        emoji = "❤️"
    if emoji not in EMOJIS:
        raise ValueError("unsupported emoji; choose one from the tool schema")
    targets = json.loads((ROOT / "reaction-targets.json").read_text())
    stamp = targets.get(str(message_id))
    if stamp is None or time.time() - stamp >= 86400:
        raise ValueError("target is not a recently verified message in the bound private chat")
    binding = json.loads((ROOT / "binding.json").read_text())
    token = (ROOT / "bot-token").read_text().strip()
    payload = {
        "chat_id": binding["chat_id"], "message_id": message_id,
        "reaction": [{"type": "emoji", "emoji": "❤" if emoji == "❤️" else emoji}],
        "is_big": big,
    }
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + token + "/setMessageReaction",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("Telegram rejected the reaction (HTTP " + str(error.code) + ")") from None
    except Exception:
        raise RuntimeError("Telegram connection failed; reaction is not confirmed") from None
    if not result.get("ok") or result.get("result") is not True:
        raise RuntimeError("Telegram did not confirm the reaction")
    return {"ok": True, "message_id": message_id, "emoji": emoji}

def dispatch(method, params):
    if method == "initialize":
        return {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                "serverInfo": {"name": "telegram-desire-reactions", "version": "1.0.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{
            "name": "react_to_message",
            "description": "给用户的 Telegram 私聊消息贴一个表情反应。使用当前回合附带的 Telegram message_id；只有经聊天桥验证的最近消息可操作。成功返回后才可以说已贴好。不是发送文字、贴纸或主动消息。按聊天需要选择，不必每条调用。",
            "inputSchema": {"type": "object", "properties": {
                "message_id": {"type": "integer", "minimum": 1},
                "emoji": {"type": "string", "enum": EMOJIS},
                "is_big": {"type": "boolean", "default": False},
            }, "required": ["message_id", "emoji"], "additionalProperties": False},
            "annotations": {"readOnlyHint": False, "destructiveHint": False,
                            "idempotentHint": True, "openWorldHint": True},
        }]}
    if method == "tools/call":
        if params.get("name") != "react_to_message":
            raise ValueError("unknown tool")
        try:
            result = set_reaction(params.get("arguments", {}))
            return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "isError": False}
        except ValueError as error:
            message = str(error)
        except RuntimeError as error:
            message = str(error)
        except Exception:
            message = "Reaction failed; no success was confirmed."
        return {"content": [{"type": "text", "text": message}], "isError": True}
    raise LookupError("unsupported method")

def main():
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if "id" not in request:
                continue
            result = dispatch(request.get("method"), request.get("params", {}))
            response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except Exception:
            response = {"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else None,
                        "error": {"code": -32603, "message": "Invalid or unsupported request"}}
        print(json.dumps(response, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
