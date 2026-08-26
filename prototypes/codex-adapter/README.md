# Codex adapter real-boundary probe

Disposable issue #91 probe; it must not merge as production adapter code.

```sh
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/codex-adapter/probe.mjs
```

It attests the locally available Codex binary/schema, registers a real app-server
before spawn, negotiates v2, starts one ephemeral read-only turn, interrupts it,
and proves provisional terminal observation is followed by process cleanup. This
desktop run is a negative qualification control: it cannot qualify the missing
signed release manifest, scoped broker, or `kogg-writable-agent-v1` Linux profile.
