# Ranex kernel/evidence real-boundary probe

Disposable issue #105 probe; it must not merge as production kernel code.

```sh
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/kernel-evidence/probe.mjs
```

The probe starts the real pinned Ranex adapter through the production operation
registry, inspects its actual v1 capability surface, exercises every advertised
application command, and proves the v2 evidence contract must remain disabled.
It records process start, protocol refusal, exit, and cleanup without raw frames.

