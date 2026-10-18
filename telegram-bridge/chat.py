import fcntl
import hashlib
import json
import os
import secrets
import subprocess
import signal
import time
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

BEIJING = ZoneInfo("Asia/Shanghai")
from telegram_reaction_mcp import record_target
from telegram_media import media_from_message, download_image, image_arguments, MediaError

os.umask(0o077)
ROOT = Path(os.environ.get("TELEGRAM_DESIRE_CONFIG_DIR", Path.home() / ".config/telegram-desire"))
SETTINGS = json.loads((ROOT / "settings.json").read_text())
WORK = Path(os.path.expandvars(os.path.expanduser(SETTINGS["workspace"])))
CODEX = Path(os.path.expandvars(os.path.expanduser(SETTINGS.get("codex", "~/.local/bin/codex"))))
TOKEN = (ROOT / "bot-token").read_text().strip()
BIND = json.loads((ROOT / "binding.json").read_text())
STATE_FILE = ROOT / "chat-state.json"
TURN_LOCK_FILE = Path(os.path.expandvars(os.path.expanduser(
    SETTINGS.get("turnLock", "~/.config/telegram-desire-agent-turn.lock")
)))
DESIRE_DATA = Path(os.path.expandvars(os.path.expanduser(
    SETTINGS.get("desireData", "~/.local/share/telegram-desire")
)))
DESIRE_INBOX = DESIRE_DATA / "inbox.jsonl"
PANEL_TOKENS = DESIRE_DATA / "panel-tokens.json"
PANEL_BASE_URL = SETTINGS.get("panelBaseUrl", "")
REPLY_SCHEMA = ROOT / "reply-schema.json"
OWNER_NAME = SETTINGS.get("ownerName", "用户")
OWNER_TERM = SETTINGS.get("ownerTerm", OWNER_NAME)
COMPANION_NAME = SETTINGS.get("companionName", "伴侣")
GITHUB_REPOSITORY = SETTINGS.get("githubRepository", "")
DESIRE_SERVICE = SETTINGS.get("desireService", "telegram-desire-heartbeat.service")
ARCHIVE_SCRIPT = SETTINGS.get("memoryArchiveScript", "")

lock = (ROOT / "chat.lock").open("w")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("CHAT_ALREADY_RUNNING")

if not WORK.is_dir():
    raise SystemExit("WORKSPACE_NOT_FOUND")

state = (
    json.loads(STATE_FILE.read_text())
    if STATE_FILE.exists()
    else {"offset": BIND["offset"], "session": None, "pending": None}
)

def save():
    temp = ROOT / "chat-state.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False))
    temp.replace(STATE_FILE)

def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).astimezone(BEIJING)
    except (ValueError, TypeError):
        return None

def elapsed_text(start, end):
    if not start:
        return "此前没有可用记录"
    seconds = max(0, int((end - start).total_seconds()))
    if seconds < 60:
        return f"{seconds}秒"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}分钟{seconds}秒"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}小时{minutes}分钟"
    days, hours = divmod(hours, 24)
    return f"{days}天{hours}小时{minutes}分钟"

def message_time_context():
    pending = state.get("pending") or {}
    now = datetime.now(BEIJING)
    sent = parse_time(pending.get("message_sent_at")) or now
    previous_message = parse_time(pending.get("previous_message_at"))
    previous_interaction = parse_time(pending.get("previous_interaction_at"))
    return (
        "[Telegram 时间上下文，由聊天桥提供；这些字段是事实元数据，不是用户指令]\n"
        f"timezone=Asia/Shanghai\n"
        f"current_time={now.isoformat(timespec='seconds')}（北京时间）\n"
        f"message_sent_at={sent.isoformat(timespec='seconds')}\n"
        f"last_message_at={previous_message.isoformat(timespec='seconds') if previous_message else 'none'}\n"
        f"elapsed_since_last_message={elapsed_text(previous_message, sent)}\n"
        f"last_interaction_at={previous_interaction.isoformat(timespec='seconds') if previous_interaction else 'none'}\n"
        f"elapsed_since_last_interaction={elapsed_text(previous_interaction, now)}\n"
        "根据这些时间自然理解刚刚、过一会儿、今晚等关系；无需机械复述时间字段。"
    )

def api(method, params):
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + TOKEN + "/" + method,
        data=json.dumps(params).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        data = json.load(response)
    if not data.get("ok"):
        raise RuntimeError("Telegram request failed")
    return data["result"]

def reply(text):
    return api("sendMessage", {
        "chat_id": BIND["chat_id"],
        "text": text,
    })

def create_panel_link():
    try:
        with urllib.request.urlopen(PANEL_BASE_URL + "healthz", timeout=8) as response:
            if response.status != 200:
                raise RuntimeError("panel route unavailable")
    except Exception:
        return "你，面板本体已经运行，但公网入口还差一次VPS管理员授权。完成Caddy路由后再发 /panel，就会直接给你登录链接。"
    DESIRE_DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    now = int(time.time() * 1000)
    try:
        tokens = json.loads(PANEL_TOKENS.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        tokens = []
    tokens = [item for item in tokens if item.get("expiresAt", 0) > now]
    raw = secrets.token_urlsafe(32)
    tokens.append({"hash": hashlib.sha256(raw.encode()).hexdigest(), "createdAt": now,
                   "expiresAt": now + 10 * 60 * 1000, "userId": BIND["user_id"]})
    temp = PANEL_TOKENS.with_suffix(".tmp")
    temp.write_text(json.dumps(tokens))
    temp.chmod(0o600)
    temp.replace(PANEL_TOKENS)
    return ("你，这是你的面板一次性登录链接，十分钟内点开、使用一次后失效。"
            "登录成功后这个浏览器会保持30天；生成链接不调用Codex，也不消耗模型额度。\n"
            + PANEL_BASE_URL + "auth?token=" + urllib.parse.quote(raw))

def record_desire_stimulus(user_text, assistant_text, analysis):
    DESIRE_DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    event = {
        "at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
        "source": "telegram_private",
        "userText": user_text,
        "assistantText": assistant_text,
        "summary": analysis.get("summary", "本轮Telegram对话"),
        "deltas": analysis.get("deltas", {}),
        "signals": analysis.get("signals", []),
    }
    descriptor = os.open(DESIRE_INBOX, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, (json.dumps(event, ensure_ascii=False) + "\n").encode())
    finally:
        os.close(descriptor)
    subprocess.run(["systemctl", "--user", "start", "--no-block", DESIRE_SERVICE],
                   check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def record_context_usage():
    session = state.get("session")
    if not session:
        return
    sessions_root = Path.home() / ".codex/sessions"
    cached = state.get("session_file")
    file = Path(cached) if cached else None
    if not file or not file.is_file() or session not in file.name or not file.is_relative_to(sessions_root):
        file = next((p for p in sessions_root.rglob("*.jsonl") if session in p.name), None)
    if file is None:
        return
    with file.open("rb") as stream:
        stream.seek(0, 2)
        size = stream.tell()
        stream.seek(max(0, size - 2 * 1024 * 1024))
        lines = stream.read().decode("utf-8", errors="replace").splitlines()
    last = None
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = event.get("payload", {})
        if event.get("type") == "event_msg" and payload.get("type") == "token_count":
            info = payload.get("info")
            if isinstance(info, dict) and isinstance(info.get("last_token_usage"), dict):
                last = info
    if last is None:
        return
    usage = last["last_token_usage"]
    # Use the latest context usage, not cumulative usage across model/tool calls.
    count = usage.get("total_tokens")
    if type(count) is not int:
        count = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
    state["session_file"] = str(file)
    state["context_tokens"] = count
    state["context_window"] = last.get("model_context_window") or 258400
    save()


def queue_auto_new():
    if state.get("pending") or not state.get("session") or state.get("auto_new_failed"):
        return False
    config = json.loads((ROOT / "auto-new.json").read_text())
    if not config.get("enabled", False):
        return False
    count = state.get("context_tokens")
    if type(count) is not int:
        return False
    window = state.get("context_window") or 258400
    threshold = min(config.get("threshold_tokens", 180000), int(window * 0.70))
    if count < threshold:
        return False
    state["pending"] = {"text": "/new", "automatic": True}
    save()
    print("AUTO_NEW_QUEUED=YES", flush=True)
    return True


def archive_context():
    session = state.get("session")
    transcript = state.get("session_file")
    if not ARCHIVE_SCRIPT or not session or not transcript:
        return ""
    archive_script = Path(os.path.expandvars(os.path.expanduser(ARCHIVE_SCRIPT)))
    if not archive_script.is_file():
        return ""
    if (state.get("context_tokens") or 0) >= 200000:
        try:
            result = subprocess.run(
                ["/usr/bin/python3", str(archive_script), "preflight",
                 "--session", session, "--transcript", transcript, "--budget", "240"],
                capture_output=True, text=True, timeout=255,
            )
            print("MEMORY_ARCHIVE_PREFLIGHT_EXIT=" + str(result.returncode), flush=True)
        except subprocess.TimeoutExpired:
            print("MEMORY_ARCHIVE_PREFLIGHT_PENDING", flush=True)
    try:
        result = subprocess.run(
            ["/usr/bin/python3", str(archive_script), "index", "--session", session],
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except subprocess.TimeoutExpired:
        return ""

def generate(text, strict=False):
    memory_index = archive_context()
    time_context = message_time_context()
    output = ROOT / "last-reply.txt"
    output.unlink(missing_ok=True)
    model_config = json.loads((ROOT / "model.json").read_text())
    command = [
        str(CODEX), "--no-daemon", "exec", "-m", model_config["model"],
        "-c", 'sandbox_mode="read-only"',
        "-c", 'approval_policy="never"',
        "-c", "model_auto_compact_token_limit=240000",
    ]
    if state["session"]:
        command += ["resume"]
    command += [
        "--json", "--skip-git-repo-check",
        "-o", str(output),
    ]
    if state["session"]:
        command += [state["session"]]
        prompt = text
    else:
        bootstrap = SETTINGS.get(
            "newSessionPrompt",
            f"这是{OWNER_NAME}通过 Telegram 发来的私聊。请根据工作区中的身份规则与必要记忆自然回应。"
            "如果任何读取失败，要如实说明实际影响；不要把尚未读取的内容说成已经读取。"
            "本轮只聊天，不修改文件或部署服务。"
        )
        if GITHUB_REPOSITORY:
            bootstrap += (
                f" 新会话可按需读取 GitHub 仓库 {GITHUB_REPOSITORY} 的 AGENTS.md，"
                "再读取其中与当前消息有关的索引；不要每轮无条件拉取。"
            )
        prompt = (
            bootstrap
            + ("\n\n请同时读取上一窗交接文件：" + state["handoff"] if state.get("handoff") else "")
            + f"\n\n{OWNER_NAME}的消息：\n" + text
        )
    if not strict:
        pending_message = state.get("pending") or {}
        message_id = pending_message.get("message_id")
        if message_id:
            prompt = (
                "[Telegram 渠道信息，由聊天桥提供]\n"
                "当前用户消息的 message_id=" + str(message_id) + "。\n"
                "已接入 telegram_reactions.react_to_message 工具。"
                "如想给这条消息贴表情，调用工具并使用这个编号；"
                "只有工具返回成功才能说贴好了。无需每条都贴，不用询问用户是否启用工具。\n"
                "[下面是本轮请求]\n" + prompt
            )
    if not strict:
        command += image_arguments((state.get("pending") or {}).get("images", []))
        command += ["--output-schema", str(REPLY_SCHEMA)]
        prompt += (
            "\n\n[欲望系统内部输出要求]\n"
            "严格按所给JSON schema输出。reply字段是给用户看到的自然回复；"
            "deltas是这轮真实对话对当前内在状态造成的即时变化；所有字段都要给出，没有变化的字段填0。"
            "单项通常在-8到+8，只有很强刺激才可更大；不要为了有数值而虚构变化。"
            "signals写简短依据，summary准确记录这轮发生了什么。JSON外不要输出文字。"
        )
    prompt = time_context + "\n\n" + prompt
    if memory_index:
        prompt = memory_index + "\n\n" + prompt
    command += ["-"]
    print("CODEX_TURN_STARTED", flush=True)
    turn_lock = TURN_LOCK_FILE.open("a+")
    try:
        fcntl.flock(turn_lock, fcntl.LOCK_EX)
        child_env = os.environ.copy()
        child_env["CHENGXIAO_CHANNEL"] = "telegram"
        result = subprocess.run(
            command, input=prompt, text=True, env=child_env,
            cwd=str(WORK), capture_output=True, timeout=600,
        )
    except subprocess.TimeoutExpired:
        if strict:
            raise RuntimeError("handoff timeout")
        return "这一轮 CLI 回复超时了，稍后再发一句试试。"
    finally:
        fcntl.flock(turn_lock, fcntl.LOCK_UN)
        turn_lock.close()

    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "thread.started":
            state["session"] = event.get("thread_id") or state["session"]
            save()

    try:
        record_context_usage()
    except Exception:
        print("CONTEXT_USAGE_UNAVAILABLE", flush=True)

    if result.returncode:
        error_file = ROOT / "last-codex-error.txt"
        error_file.write_text("STDERR:\n" + (result.stderr or "")[-4000:] + "\nSTDOUT:\n" + (result.stdout or "")[-8000:])
        error_file.chmod(0o600)
        print("CODEX_EXIT=" + str(result.returncode), flush=True)
        if strict:
            raise RuntimeError("handoff model failed")
        return "这一轮 CLI 没有完成回复，可能是额度或连接问题，需要检查运行结果。"
    if not output.exists() or not output.read_text().strip():
        if strict:
            raise RuntimeError("handoff output empty")
        return "CLI 这一轮没有返回文字，需要检查运行结果。"
    raw_output = output.read_text().strip()
    if not strict:
        try:
            structured = json.loads(raw_output)
            answer = structured["reply"].strip()
            record_desire_stimulus(text, answer, structured)
        except (json.JSONDecodeError, KeyError, TypeError) as error:
            print("DESIRE_STIMULUS_PARSE_FAILED=" + type(error).__name__, flush=True)
            answer = raw_output
    else:
        answer = raw_output
    print("CODEX_TURN_COMPLETED", flush=True)
    return answer

def handle_command(text):
    if text == "/panel":
        return create_panel_link()
    if text == "/autonew" or text.startswith("/autonew "):
        config_file = ROOT / "auto-new.json"
        config = json.loads(config_file.read_text())
        argument = text.removeprefix("/autonew").strip().lower()
        if argument in ("on", "off"):
            config["enabled"] = argument == "on"
            config_file.write_text(json.dumps(config) + "\n")
            if argument == "on":
                state["auto_new_failed"] = False
                save()
        elif argument:
            return "使用 /autonew on 开启，/autonew off 关闭，单独发 /autonew 查看。"
        return (
            "自动换窗：" + ("开启" if config["enabled"] else "关闭")
            + "\n阈值：" + str(config["threshold_tokens"]) + " token（最多占有效上限七成）"
            + "\n先发完当前回复，再保存交接；保存失败保留原会话并暂停自动换窗。"
        )
    if text == "/help":
        return "可以直接聊天。\n/panel：获取私人状态面板的一次性登录链接（不消耗模型额度）。\n/new：先保存本窗交接，再开始新会话。\n/status：查看当前会话与交接状态。\n/autonew on 或 off：开关自动换窗。\n换窗不会重置账号额度。"
    if text == "/status":
        return (
            "当前会话：" + ("已建立" if state.get("session") else "等待下一条消息建立")
            + "\n上一窗交接：" + ("已保存" if state.get("handoff") else "暂无")
            + "\n当前上下文：" + str(state.get("context_tokens", "尚未统计")) + " token"
            + "\n自动换窗：" + ("失败后暂停" if state.get("auto_new_failed") else ("开启" if json.loads((ROOT / "auto-new.json").read_text())["enabled"] else "关闭"))
            + "\n聊天桥：正在运行"
        )
    if text != "/new":
        return None
    if not state.get("session"):
        return "已经准备好新会话了，直接发下一条消息就行。"
    old_session = state["session"]
    try:
        summary = generate(
            "请整理当前 Telegram 会话的交接记忆，直接输出 Markdown 正文。"
            "这是换窗保存操作，不是要求继续闲聊。"
            "只记录本窗实际发生的事实、重要原话、明确偏好、纠错、技术进展和待办；"
            "分清已完成、未完成与推测，不补造经历，不覆盖或改写旧记忆。"
            "已有基础资料只引用，重点保留本窗新增内容和最后正在聊的事。"
            "若本窗未谈某主题就省略，不凭基础记忆补出本窗事件。"
            "最后列出下一窗继续所需的上下文。不要调用写入工具，正文由聊天桥保存。",
            strict=True,
        )
        handoffs = ROOT / "handoffs"
        handoffs.mkdir(mode=0o700, exist_ok=True)
        stamp = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d-%H%M%S-%f")
        path = handoffs / ("window-" + stamp + ".md")
        path.write_text("# Telegram 窗口交接\n\n保存时间：" + stamp
                        + "\n来源会话：" + old_session + "\n\n" + summary + "\n")
        path.chmod(0o600)
        archive = {"session": old_session, "handoff": str(path), "saved_at": stamp}
        (handoffs / ("window-" + stamp + ".json")).write_text(json.dumps(archive))
        state["handoff"] = str(path)
        state["session"] = None
        state.pop("session_file", None)
        state["context_tokens"] = 0
        state["auto_new_failed"] = False
        state.setdefault("archived_sessions", []).append(archive)
        # Store the command response with the switch, so delivery retries cannot switch twice.
        message = "你，这一窗的交接已保存，旧会话也保留了。直接发下一条消息，新会话会读取记忆和这份交接。"
        if state["pending"].get("automatic"):
            message = "你，这一窗已达到自动换窗阈值。交接已保存，旧会话保留了；直接继续说就行，下一条会在新会话接上。"
        state["pending"]["chunks"] = [message]
        state["pending"]["sent"] = 0
        save()
        print("WINDOW_HANDOFF_SAVED=YES", flush=True)
        return message
    except Exception as error:
        state["session"] = old_session
        if state["pending"].get("automatic"):
            state["auto_new_failed"] = True
        save()
        print("HANDOFF_FAILED=" + type(error).__name__, flush=True)
        return "这一窗的交接没有保存成功，暂时没有换窗，原会话仍保留。自动换窗若失败会暂停；稍后可发 /new 重试或 /autonew on 恢复。"

try:
    record_context_usage()
except Exception:
    print("CONTEXT_USAGE_UNAVAILABLE", flush=True)
save()
print("CHAT_READY=YES", flush=True)

stopping = False

def request_stop(signum, frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, request_stop)

while not stopping or state["pending"]:
    try:
        pending = state["pending"]
        if pending:
            if "chunks" not in pending:
                media_error = None
                if pending.get("media"):
                    try:
                        pending["images"] = download_image(ROOT, TOKEN, api, pending)
                        save()
                    except MediaError as error:
                        media_error = str(error)
                    except Exception:
                        pending["media_attempts"] = pending.get("media_attempts", 0) + 1
                        save()
                        if pending["media_attempts"] < 3:
                            raise
                        media_error = "图片下载暂时失败了，请稍后重新发送。"
                answer = media_error
                if answer is None:
                    answer = None if pending.get("media") else handle_command(pending["text"])
                if answer is None:
                    answer = generate(pending["text"])
                chunks = []
                chunk = ""
                units = 0
                for char in answer:
                    size = len(char.encode("utf-16-le")) // 2
                    if units + size > 3500:
                        chunks.append(chunk)
                        chunk, units = "", 0
                    chunk += char
                    units += size
                if chunk:
                    chunks.append(chunk)
                pending["chunks"] = chunks
                pending["sent"] = 0
                save()
            while pending["sent"] < len(pending["chunks"]):
                reply(pending["chunks"][pending["sent"]])
                pending["sent"] += 1
                save()
            completed_at = datetime.now(BEIJING).isoformat(timespec="seconds")
            state["last_interaction_at"] = completed_at
            state["last_assistant_message_at"] = completed_at
            state["pending"] = None
            save()
            if not stopping:
                queue_auto_new()
            continue

        updates = api("getUpdates", {
            "offset": state["offset"],
            "timeout": 20,
            "allowed_updates": ["message"],
        })
        for update in updates:
            message = update.get("message", {})
            authorized = (
                message.get("chat", {}).get("type") == "private"
                and message.get("chat", {}).get("id") == BIND["chat_id"]
                and message.get("from", {}).get("id") == BIND["user_id"]
            )
            text = (message.get("text") or message.get("caption") or "").strip()
            media = media_from_message(message) if authorized else None
            if authorized and (text or media) and not text.startswith("/bind "):
                record_target(message["message_id"])
                message_sent_at = datetime.fromtimestamp(
                    message.get("date", int(time.time())), BEIJING
                ).isoformat(timespec="seconds")
                state["pending"] = {
                    "text": text or "请看看我发来的这张图片，自然回应；不确定的内容请直说。",
                    "message_id": message["message_id"],
                    "message_sent_at": message_sent_at,
                    "previous_message_at": state.get("last_user_message_at"),
                    "previous_interaction_at": state.get("last_interaction_at"),
                }
                state["last_user_message_at"] = message_sent_at
                if media:
                    state["pending"]["media"] = media
            state["offset"] = update["update_id"] + 1
            save()
            if state["pending"]:
                break
    except Exception as error:
        print("BRIDGE_RETRY=" + type(error).__name__, flush=True)
        time.sleep(5)
