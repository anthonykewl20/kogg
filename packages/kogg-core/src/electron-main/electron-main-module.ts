import { ElectronMainProcessArgv } from '@theia/core/lib/electron-main/electron-main-application';
import { ContainerModule } from '@theia/core/shared/inversify';
import { app } from '@theia/electron/shared/electron';

// diagnostic-coverage: core.runtime

class KoggElectronMainProcessArgv extends ElectronMainProcessArgv {
  override get isBundledElectronApp(): boolean {
    // Electron's process.defaultApp is unset for Playwright development
    // launches on Linux. app.isPackaged is the authoritative runtime signal
    // and remains true for Kogg's distributable artifacts on every platform.
    return isBundledElectronApplication(this.isElectronApp, app.isPackaged);
  }

  override getProcessArgvWithoutBin(argv = process.argv): string[] {
    if (!this.isElectronApp || this.isBundledElectronApp) return super.getProcessArgvWithoutBin(argv);
    const { args, debugSwitches } = normalizeUnbundledElectronArgv(argv);
    if (debugSwitches) {
      console.debug('[kogg:core:electron-main] playwright-switches.normalized', { switchCount: debugSwitches });
    }
    return args;
  }
}

export function isBundledElectronApplication(isElectronApp: boolean, isPackaged: boolean): boolean {
  return isElectronApp && isPackaged;
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
