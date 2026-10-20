#!/usr/bin/env python3
import fcntl
import json
import multiprocessing as mp
import os
import tempfile
import time
from pathlib import Path

def atomic(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value))
    os.replace(temp, path)

def locked_update(lock_path, state_path, mutate):
    with lock_path.open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(state_path.read_text())
        result = mutate(state)
        atomic(state_path, state)
        fcntl.flock(lock, fcntl.LOCK_UN)
        return result

def autonomy(lock_path, state_path, begun, finished):
    def begin(state):
        state['inFlight'] = {'wakeId': 'wake-1', 'startedAt': 1000}
    locked_update(lock_path, state_path, begin)
    begun.set()

    # Simulated model call happens outside state.lock.
    time.sleep(0.45)

    def complete(state):
        if state.get('inFlight', {}).get('wakeId') != 'wake-1':
            return
        state['libido'] -= 11
        state['lastAttemptAt'] = 2000
        state['lastSuccessAt'] = 2000
        state['inFlight'] = None
    locked_update(lock_path, state_path, complete)
    finished.set()

def ingest(lock_path, state_path, begun, report):
    begun.wait(2)
    time.sleep(0.05)
    start = time.monotonic()
    def apply(state):
        state['attachment'] += 7
        state['libido'] += 6
        state['inboxApplied'] += 1
    locked_update(lock_path, state_path, apply)
    report.put(time.monotonic() - start)

def main():
    with tempfile.TemporaryDirectory(prefix='scheduler-lock-sim-') as raw:
        root = Path(raw)
        state_path = root / 'state.json'
        lock_path = root / 'state.lock'
        atomic(state_path, {
            'attachment': 50,
            'libido': 75,
            'inboxApplied': 0,
            'inFlight': None,
            'lastAttemptAt': None,
            'lastSuccessAt': None,
        })
        begun = mp.Event()
        finished = mp.Event()
        report = mp.Queue()
        a = mp.Process(target=autonomy, args=(lock_path, state_path, begun, finished))
        b = mp.Process(target=ingest, args=(lock_path, state_path, begun, report))
        a.start(); b.start()
        a.join(3); b.join(3)
        assert a.exitcode == 0 and b.exitcode == 0
        wait = report.get(timeout=1)
        state = json.loads(state_path.read_text())
        assert wait < 0.20, f'ingest waited too long: {wait:.3f}s'
        assert state['attachment'] == 57, state
        assert state['libido'] == 70, state
        assert state['inboxApplied'] == 1, state
        assert state['inFlight'] is None, state

        before = dict(state)
        def duplicate(state):
            if (state.get('inFlight') or {}).get('wakeId') == 'wake-1':
                state['libido'] -= 11
        locked_update(lock_path, state_path, duplicate)
        assert json.loads(state_path.read_text()) == before

        delivery_lock = root / 'delivery.lock'
        activity_path = root / 'activity.json'
        activity_path.write_text(json.dumps({'lastUserMessageAt': 2000}))
        with delivery_lock.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            marker = json.loads(activity_path.read_text())['lastUserMessageAt']
            assert marker > 1000
            decision = 'suppressed'
            fcntl.flock(lock, fcntl.LOCK_UN)
        assert decision == 'suppressed'

        print(json.dumps({
            'ok': True,
            'ingest_lock_wait_ms': round(wait * 1000, 2),
            'final_attachment': state['attachment'],
            'final_libido': state['libido'],
            'duplicate_wake_ignored': True,
            'stale_contact_suppressed': True,
        }, ensure_ascii=False))

if __name__ == '__main__':
    main()
