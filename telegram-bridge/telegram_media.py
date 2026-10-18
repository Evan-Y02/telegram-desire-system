import fcntl
import json
import os
import time
import urllib.request
from pathlib import Path

MAX_BYTES = 20 * 1024 * 1024
RETENTION = 48 * 3600
SUFFIXES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
class MediaError(Exception):
    pass

def media_from_message(message):
    photos = message.get("photo") or []
    if photos:
        item = max(photos, key=lambda p: p.get("width", 0) * p.get("height", 0))
        return {"file_id": item["file_id"], "size": item.get("file_size", 0), "suffix": ".jpg"}
    item = message.get("document") or {}
    suffix = SUFFIXES.get(item.get("mime_type"))
    if suffix:
        return {"file_id": item["file_id"], "size": item.get("file_size", 0), "suffix": suffix}
    return None

def image_arguments(paths):
    args = []
    for path in paths:
        args += ["--image", str(path)]
    return args

def download_image(root, token, api, pending, opener=None):
    media = pending.get("media")
    if not media:
        return []
    if media.get("size", 0) > MAX_BYTES:
        raise MediaError("图片超过 20MB，请压缩后重新发送。")
    folder = root / "images"
    folder.mkdir(mode=0o700, exist_ok=True)
    suffix = media["suffix"]
    if suffix not in SUFFIXES.values():
        raise MediaError("暂时只支持 JPG、PNG 和 WebP 图片。")
    target = folder / (str(int(pending["message_id"])) + suffix)
    with (root / "media.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if target.is_file() and target.stat().st_size:
            return [str(target)]
        meta = api("getFile", {"file_id": media["file_id"]})
        if meta.get("file_size", 0) > MAX_BYTES:
            raise MediaError("图片超过 20MB，请压缩后重新发送。")
        remote = meta.get("file_path", "")
        if not remote or remote.startswith("/") or ".." in remote.split("/"):
            raise MediaError("没有取得图片下载地址，请重新发送。")
        url = "https://api.telegram.org/file/bot" + token + "/" + remote
        temp = target.with_suffix(suffix + ".part")
        total = 0
        try:
            with (opener or urllib.request.urlopen)(url, timeout=45) as response, temp.open("wb") as output:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise MediaError("图片超过 20MB，请压缩后重新发送。")
                    output.write(chunk)
            if not total:
                raise MediaError("收到的图片是空文件，请重新发送。")
            temp.chmod(0o600)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
    return [str(target)]

def cleanup(root, now=None):
    now = time.time() if now is None else now
    folder = root / "images"
    if not folder.exists():
        return 0
    removed = 0
    with (root / "media.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_file = root / "chat-state.json"
        try:
            state = json.loads(state_file.read_text()) if state_file.exists() else {}
        except (ValueError, OSError):
            return 0
        pending = state.get("pending") or {}
        protected = {Path(p).name for p in pending.get("images", [])}
        if pending.get("media") and pending.get("message_id") is not None:
            protected.add(str(int(pending["message_id"])) + pending["media"]["suffix"])
        for path in folder.iterdir():
            if path.is_symlink() or not path.is_file() or path.name in protected:
                continue
            if path.suffix not in {".jpg", ".png", ".webp", ".part"}:
                continue
            if now - path.stat().st_mtime >= RETENTION:
                path.unlink()
                removed += 1
    return removed

if __name__ == "__main__":
    root = Path(os.environ.get("TELEGRAM_DESIRE_CONFIG_DIR", Path.home() / ".config/telegram-desire"))
    print("MEDIA_CLEANED=" + str(cleanup(root)))
