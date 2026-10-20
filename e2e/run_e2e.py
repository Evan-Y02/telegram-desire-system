#!/usr/bin/env python3
import fcntl
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKER = ROOT / "e2e" / "worker.mjs"
DEFAULT_CONFIG = ROOT / "desire-system" / "config" / "default.example.json"
NODE = shutil.which("node")
FLOCK = shutil.which("flock")
assert NODE and FLOCK

class Harness:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="scheduler-e2e-", dir=str(ROOT / "e2e"))
        self.runtime = pathlib.Path(self.tmp.name)
        self.delivery_lock = self.runtime / "delivery.lock"
        self.state_lock = self.runtime / "state.lock"
        config = json.loads(DEFAULT_CONFIG.read_text())
        config["initial"].update({"attachment": 50, "longing": 64, "libido": 70})
        config["autonomy"]["restCooldownMinutes"] = 10
        config["autonomy"]["globalCooldownMinutes"] = 0
        (self.runtime / "config.json").write_text(json.dumps(config))
        self.config = config
        self.call("init", 1_000)

    def close(self):
        self.tmp.cleanup()

    def call(self, command, now, wake_id=None, locks=True):
        args = [NODE, str(WORKER), command, str(self.runtime), str(now)]
        if wake_id is not None:
            args.append(wake_id)
        if locks:
            args = [FLOCK, str(self.delivery_lock), FLOCK, str(self.state_lock)] + args
        result = subprocess.run(args, check=True, capture_output=True, text=True)
        return json.loads(result.stdout.strip())

    def read_json(self, name):
        return json.loads((self.runtime / name).read_text())

    def fake_tg_receive(self, at_ms, deltas, summary):
        started = time.perf_counter()
        with self.delivery_lock.open("a+") as dl:
            fcntl.flock(dl, fcntl.LOCK_EX)
            with self.state_lock.open("a+") as sl:
                fcntl.flock(sl, fcntl.LOCK_EX)
                (self.runtime / "activity.json").write_text(
                    json.dumps({"lastUserMessageAt": at_ms}) + "\n"
                )
                event = {
                    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at_ms / 1000)),
                    "source": "fake_telegram_private",
                    "deltas": deltas,
                    "summary": summary,
                }
                with (self.runtime / "inbox.jsonl").open("a") as out:
                    out.write(json.dumps(event) + "\n")
                result = self.call("ingest", at_ms, locks=False)
        return result, (time.perf_counter() - started) * 1000

    def fake_model(self, delay_s, payload):
        def write_result():
            time.sleep(delay_s)
            (self.runtime / "model-result.json").write_text(json.dumps(payload) + "\n")
        thread = threading.Thread(target=write_result)
        thread.start()
        return thread

    def outbox(self):
        text = (self.runtime / "fake-telegram-outbox.jsonl").read_text()
        return [json.loads(line) for line in text.splitlines() if line]

def require(condition, message):
    if not condition:
        raise AssertionError(message)

def run_once(index):
    h = Harness()
    try:
        first_at = 2_000
        ingest1, _ = h.fake_tg_receive(first_at, {"longing": 7, "libido": 4}, "first fake message")
        state = h.read_json("state.json")
        require(ingest1["events"] == 1, "first fake TG event missing")
        require(state["drives"]["longing"] == 71, "first delta not applied")
        require(not h.outbox(), "ingest unexpectedly sent a message")
        require(not [x for x in state["timeline"] if x["type"] == "autonomous_wake"],
                "chat ingest unexpectedly started autonomy")

        wake1_at = 3_000
        prepared = h.call("prepare", wake1_at, f"stale-contact-{index}")
        require(prepared["prepared"], "first wake not prepared")
        model = h.fake_model(0.40, {
            "status": "acted", "summary": "fake stale contact",
            "actions": [{"kind": "contact_wife", "intensity": "ordinary",
                         "confirmed": True, "content": "fake only"}],
        })
        time.sleep(0.08)
        _, ingest_wait_ms = h.fake_tg_receive(
            3_200, {"attachment": 7, "libido": 6}, "arrived during fake model"
        )
        model.join()
        committed = h.call("commit", 3_500)
        state = h.read_json("state.json")
        require(committed["reason"] == "new_user_message", "stale contact not suppressed")
        require(not committed["deliveredToFakeOutbox"], "stale contact reached fake outbox")
        require(not h.outbox(), "fake outbox is not empty after suppression")
        require(state["drives"]["attachment"] == 57, "concurrent attachment delta lost")
        require(state["drives"]["libido"] == 80, "concurrent libido delta lost")
        require(state["drives"]["longing"] == 71, "suppressed contact settled longing")

        retry1 = state["autonomy"]["retryAfter"]
        too_early = h.call("prepare", retry1 - 1, f"early-{index}")
        require(not too_early["prepared"], "rest/supersede backoff ignored")

        rest_at = retry1
        prepared = h.call("prepare", rest_at, f"rest-{index}")
        require(prepared["prepared"], "rest wake not prepared")
        before_rest = h.read_json("state.json")["drives"]
        (h.runtime / "model-result.json").write_text(json.dumps({
            "status": "rested", "summary": "fake rest",
            "actions": [{"kind": "rest", "confirmed": True}],
        }) + "\n")
        rest_commit = h.call("commit", rest_at + 100)
        state = h.read_json("state.json")
        require(rest_commit["reason"] == "rest", "rest result not recorded")
        require(state["drives"] == before_rest, "rest changed drive values")
        retry2 = state["autonomy"]["retryAfter"]
        require(retry2 == rest_at + 100 + 600_000, "rest cooldown is not ten minutes")
        require(not h.call("prepare", retry2 - 1, f"rest-early-{index}")["prepared"],
                "wake prepared before rest cooldown expired")

        contact_at = retry2
        prepared = h.call("prepare", contact_at, f"current-contact-{index}")
        require(prepared["prepared"], "current contact wake not prepared")
        (h.runtime / "model-result.json").write_text(json.dumps({
            "status": "acted", "summary": "fake current contact",
            "actions": [{"kind": "contact_wife", "intensity": "ordinary",
                         "confirmed": True, "content": "fake delivered"}],
        }) + "\n")
        contact_commit = h.call("commit", contact_at + 100)
        require(contact_commit["reason"] == "acted", "current contact did not act")
        require(contact_commit["deliveredToFakeOutbox"], "current contact not in fake outbox")
        require(len(h.outbox()) == 1, "fake outbox should contain exactly one delivery")
        state_after = h.read_json("state.json")
        require(state_after["drives"]["longing"] == 57, "contact settlement not applied once")

        duplicate = h.call("commit", contact_at + 200)
        require(not duplicate["applied"] and duplicate["reason"] == "stale_wake",
                "duplicate wake commit was not rejected")
        require(not duplicate["deliveredToFakeOutbox"], "duplicate appended to fake outbox")
        require(len(h.outbox()) == 1, "duplicate delivery appeared in fake outbox")
        require(h.read_json("state.json")["drives"]["longing"] == 57,
                "duplicate commit settled longing twice")

        return {
            "iteration": index,
            "ingest_lock_ms": round(ingest_wait_ms, 2),
            "timeline_events": len(h.read_json("state.json")["timeline"]),
            "fake_outbox_deliveries": len(h.outbox()),
            "network_calls": 0,
            "real_codex_calls": 0,
            "result": "PASS",
        }
    finally:
        h.close()

def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    results = [run_once(i + 1) for i in range(count)]
    waits = [x["ingest_lock_ms"] for x in results]
    print(json.dumps({
        "suite": "isolated fake-TG/fake-Codex E2E",
        "iterations": count,
        "passed": len(results),
        "failed": 0,
        "ingest_lock_ms": {
            "min": min(waits), "max": max(waits),
            "avg": round(sum(waits) / len(waits), 2),
        },
        "network_calls": 0,
        "real_codex_calls": 0,
        "production_files_changed": 0,
        "last": results[-1],
    }, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
