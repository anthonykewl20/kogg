import { KernelBridge } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KernelBridgeToken } from '@kogg/contracts';

@injectable()
export class KernelBackendContribution implements BackendApplicationContribution {
  constructor(@inject(KernelBridgeToken) private readonly kernel: KernelBridge) {}

  async onStart(): Promise<void> {
    await this.kernel.start();
  }

  async onStop(): Promise<void> {
    await this.kernel.shutdown();
  }
}
