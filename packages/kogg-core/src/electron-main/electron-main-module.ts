import { ElectronMainProcessArgv } from '@theia/core/lib/electron-main/electron-main-application';
import { ContainerModule } from '@theia/core/shared/inversify';

// diagnostic-coverage: core.runtime

class KoggElectronMainProcessArgv extends ElectronMainProcessArgv {
  override getProcessArgvWithoutBin(argv = process.argv): string[] {
    if (!this.isElectronApp || this.isBundledElectronApp) return super.getProcessArgvWithoutBin(argv);
    const args = argv.slice(1);
    let debugSwitches = 0;
    while (/^--(?:inspect|remote-debugging-port)(?:=|$)/u.test(args[0] ?? '')) {
      args.shift();
      debugSwitches += 1;
    }
    // The first non-switch argument of an unbundled Electron process is the
    // application directory, not an argument intended for Theia's CLI.
    args.shift();
    if (debugSwitches) {
      console.debug('[kogg:core:electron-main] playwright-switches.normalized', { switchCount: debugSwitches });
    }
    return args;
  }
}

export default new ContainerModule((bind, unbind, isBound) => {
  if (isBound(ElectronMainProcessArgv)) unbind(ElectronMainProcessArgv);
  bind(ElectronMainProcessArgv).to(KoggElectronMainProcessArgv).inSingletonScope();
});
