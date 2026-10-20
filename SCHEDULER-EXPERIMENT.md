# Scheduler short-lock experiment

This branch contains an isolated scheduling experiment. It is review material, not a production-ready release.

## What is included

- `desire-system/src/scheduler.mjs`
  - chat ingestion without starting autonomy;
  - prepare/commit two-phase wake handling;
  - merge settlement onto the latest state;
  - `wakeId` stale/duplicate rejection;
  - rest backoff through `lastAttemptAt` and `retryAfter`;
  - stale `contact_wife` suppression when a newer user message exists.
- `desire-system/test/scheduler.test.mjs`: seven scheduler unit tests.
- `e2e/simulate_scheduler_locks.py`: two-process short-lock simulation.
- `e2e/worker.mjs` and `e2e/run_e2e.py`: fake-Telegram/fake-Codex end-to-end harness.

The harness makes no Telegram request and invokes no Codex process. It writes only to temporary local state and a fake outbox.

## Commands

From the repository root:

```bash
node --test desire-system/test/*.test.mjs
for i in $(seq 1 20); do python3 e2e/simulate_scheduler_locks.py; done
python3 e2e/run_e2e.py 10
```

Observed in the source environment:

- unit tests: 18/18 passed;
- two-process lock simulation: 20/20 passed;
- isolated fake-TG/fake-Codex E2E: 10/10 passed;
- real Telegram calls: 0;
- real Codex calls: 0.

## Proven scope

The E2E harness covers:

1. chat ingestion does not start an autonomous run;
2. the model wait occurs outside `state.lock`;
3. chat deltas arriving during the wait survive the final merge;
4. a newer received-user-message marker suppresses stale `contact_wife`;
5. suppressed contact does not settle longing;
6. rest changes no drive and adds a ten-minute experimental backoff;
7. a current contact enters the fake outbox once;
8. duplicate `wakeId` commit neither resends nor settles twice.

The generic settlement path remains covered by the existing engine tests, including `solo`. This E2E harness does not exercise every autonomous action through a real adapter.

## Deliberately unresolved production boundaries

1. **Crash after real Telegram success but before durable confirmation.**
   Fake-outbox deduplication proves only internal `wakeId` idempotency. It does not prove exactly-once delivery over the real Telegram API. A production adapter should use a durable outbox state machine such as `prepared -> sending -> confirmed/unknown`. After restart, `unknown` must not be blindly resent. Whether it can be reconciled depends on the Telegram transport; Bot API does not provide a general client idempotency key.

2. **Slow real network send.**
   The fake send is fast. This experiment does not prove that a slow Telegram request will not block ingestion if both `delivery.lock` and `state.lock` are held across the request. Production integration should keep `state.lock` short and should record the receive-time activity marker before waiting on the delivery path, using an independent atomic marker or equivalent receive-side state.

3. **Receive-loop concurrency.**
   The harness injects messages from a separate local path. It does not prove that a particular real Telegram receive loop continues receiving while its chat model is running. That must be verified against the target bridge architecture.

4. **No deployment integration.**
   The existing heartbeat and Telegram bridge are not rewired by this branch. Adopters must review, adapt, test, back up, and deploy in their own environment.

## Lock-order rule used by the harness

Where both locks are required, the harness uses:

```text
delivery.lock -> state.lock
```

All production code paths must use one consistent order or avoid holding both locks together.
