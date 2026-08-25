import { ElectronMainProcessArgv } from '@theia/core/lib/electron-main/electron-main-application';
import { ContainerModule } from '@theia/core/shared/inversify';

// diagnostic-coverage: core.runtime

class KoggElectronMainProcessArgv extends ElectronMainProcessArgv {
  override getProcessArgvWithoutBin(argv = process.argv): string[] {
    if (!this.isElectronApp || this.isBundledElectronApp) return super.getProcessArgvWithoutBin(argv);
    const { args, debugSwitches } = normalizeUnbundledElectronArgv(argv);
    if (debugSwitches) {
      console.debug('[kogg:core:electron-main] playwright-switches.normalized', { switchCount: debugSwitches });
    }
    return args;
  }
}

export function normalizeUnbundledElectronArgv(argv: readonly string[]): { args: string[]; debugSwitches: number } {
  const args = argv.slice(1);
  let debugSwitches = 0;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (/^--(?:inspect|remote-debugging-port)(?:=|$)/u.test(args[index] ?? '')) {
      args.splice(index, 1);
      debugSwitches += 1;
    }
  }
  // After Playwright-only switches are removed, the first argument of an
  // unbundled Electron process is the application directory rather than an
  // argument intended for Theia's CLI.
  args.shift();
  return { args, debugSwitches };
}

export default new ContainerModule((bind, unbind, isBound) => {
  if (isBound(ElectronMainProcessArgv)) unbind(ElectronMainProcessArgv);
  bind(ElectronMainProcessArgv).to(KoggElectronMainProcessArgv).inSingletonScope();
});
