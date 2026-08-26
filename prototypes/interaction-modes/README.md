# Interaction modes real-Theia boundary probe

Disposable issue #121 probe; all production-package changes on this branch are
experimental and must not merge. Only the separate findings document may merge.

```sh
yarn setup
yarn build:browser
KOGG_E2E_TASKS_ONLY=1 yarn test:e2e:browser
yarn test
```

The prototype adds a durable task-scoped Plan/Build/Kogg registry behind a real
Theia JSON-RPC service and projects it into the real Kogg Tasks widget. The
browser test uses the authenticated Kogg application and Playwright's Chromium
debug connection. It proves that Plan production mutation, Build evidence,
Build verdict, and Build merge requests are refused by the backend even though
they are invoked from the UI; Kogg alone may enter the governed lifecycle. It
then restarts the backend and verifies restoration of the exact Kogg mode.

The experimental backend is launched with a random Node inspector endpoint.
The test confirms the backend debugger endpoint and version-3 source maps for
the frontend widget, backend registry, and bundled browser. Transition/refusal/
restoration logs use safe correlations and omit task content.

Observed on 2026-08-27 with Node 22.23.2 and the development Theia browser
bundle. The focused real-browser run and the 41-test repository suite passed;
branding and all 64 observability checks passed. This probe does not implement
the six-transition cleanup/recovery matrix, private Build worktree lifecycle,
Ranex workflow anchors, or production diagnostics; those remain #122 gates.
