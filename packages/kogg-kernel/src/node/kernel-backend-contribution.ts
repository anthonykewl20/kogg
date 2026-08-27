import { KernelBridge } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KernelBridgeToken } from '@kogg/contracts';

// diagnostic-coverage: kernel.bridge, kernel.cleanup

@injectable()
export class KernelBackendContribution implements BackendApplicationContribution {
  constructor(@inject(KernelBridgeToken) private readonly kernel: KernelBridge) {}

  async onStart(): Promise<void> {
    console.info('[kogg:kernel:lifecycle] start.requested');
    await this.kernel.start();
    console.info('[kogg:kernel:lifecycle] start.completed');
  }

  async onStop(): Promise<void> {
    console.info('[kogg:kernel:lifecycle] stop.requested');
    await this.kernel.shutdown();
    console.info('[kogg:kernel:lifecycle] stop.completed');
  }
}
