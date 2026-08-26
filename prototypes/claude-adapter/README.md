# Claude adapter legal/artifact boundary probe

Disposable issue #96 probe; it must not merge as production adapter code.

```sh
yarn setup
volta run --node 22.23.2 node --inspect=0 prototypes/claude-adapter/probe.mjs
```

The probe verifies the exact cached npm artifact through a registered external
archive-inspection process, then proves that the missing repository-controlled
commercial-use approval refuses the adapter before SDK import, credential mint,
or Claude spawn. It intentionally does not execute the commercial SDK or CLI.

