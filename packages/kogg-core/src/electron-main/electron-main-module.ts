import { ElectronMainProcessArgv } from '@theia/core/lib/electron-main/electron-main-application';
import { ContainerModule } from '@theia/core/shared/inversify';

// diagnostic-coverage: core.runtime

class KoggElectronMainProcessArgv extends ElectronMainProcessArgv {
  override getProcessArgvWithoutBin(argv = process.argv): string[] {
    if (!this.isElectronApp) return super.getProcessArgvWithoutBin(argv);
    const { args, debugSwitches, applicationDirectoryRemoved } = normalizeUnbundledElectronArgv(argv);
    // Electron 42 on Linux can leave process.defaultApp unset under Playwright,
    // which makes Theia report a development launch as bundled. A Playwright
    // debug switch followed by an application directory is unambiguously the
    // development argv shape; packaged launches begin with another switch.
    if (this.isBundledElectronApp && !(debugSwitches && applicationDirectoryRemoved)) {
      return super.getProcessArgvWithoutBin(argv);
    }
    if (debugSwitches) {
      console.debug('[kogg:core:electron-main] playwright-switches.normalized', { switchCount: debugSwitches });
    }
    return args;
  }
}

export function normalizeUnbundledElectronArgv(argv: readonly string[]): {
  args: string[];
  debugSwitches: number;
  applicationDirectoryRemoved: boolean;
} {
  const args = argv.slice(1);
  let debugSwitches = 0;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (/^--(?:inspect|remote-debugging-port)(?:=|$)/u.test(args[index] ?? '')) {
      args.splice(index, 1);
      debugSwitches += 1;
    }
  }
  // After Playwright-only switches are removed, the first positional argument
  // of an unbundled Electron process is the application directory. A packaged
  // launch instead begins with Kogg's own CLI switch and must retain it.
  const applicationDirectoryRemoved = !!args[0] && !args[0].startsWith('-');
  if (applicationDirectoryRemoved) args.shift();
  return { args, debugSwitches, applicationDirectoryRemoved };
}

export default new ContainerModule((bind, unbind, isBound) => {
  if (isBound(ElectronMainProcessArgv)) unbind(ElectronMainProcessArgv);
  bind(ElectronMainProcessArgv).to(KoggElectronMainProcessArgv).inSingletonScope();
});
