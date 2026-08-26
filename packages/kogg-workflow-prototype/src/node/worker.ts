// diagnostic-exempt: Disposable child fixture used only by the issue #100 prototype.
// observability-exempt: Deterministic child fixture; its bounded stdout is consumed as activity, never as an operational log.
const mode = process.env.KOGG_WORKFLOW_PROTOTYPE_WORKER;
if (mode === 'hang') {
  setInterval(() => process.stdout.write('activity\n'), 100);
} else {
  setTimeout(() => { process.stdout.write('complete\n'); process.exit(0); }, 80);
}
