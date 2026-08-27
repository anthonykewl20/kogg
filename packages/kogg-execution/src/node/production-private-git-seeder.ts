import { chmodSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { injectable } from '@theia/core/shared/inversify';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { ControllerGitRunner } from './controller-git-runner';
import { PrivateGitSeeder, SeedError, type PrivateGitSeedAuthority, type PrivateGitSeedRequest, type PrivateGitSeedResult } from './private-git-seeder';

// The production seeder is lazy so unsupported hosts never initialize controller Git state or spawn Git.
// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup
@injectable()
export class ProductionPrivateGitSeeder implements PrivateGitSeedAuthority {
  private delegate: PrivateGitSeeder | undefined;
  constructor(private readonly operations: OperationRegistryApi) {}

  seed(request: PrivateGitSeedRequest): Promise<PrivateGitSeedResult> {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new SeedError('GIT_SEED_FAILED');
    this.delegate ??= new PrivateGitSeeder(this.operations, productionControllerGitRunner());
    return this.delegate.seed(request);
  }
}

export function productionControllerGitRunner(): ControllerGitRunner {
  const root = path.join(stateRoot(), 'execution', 'controller-git');
  const home = path.join(root, 'home'); const templateDirectory = path.join(root, 'template');
  secureDirectory(root); secureDirectory(home); secureDirectory(templateDirectory);
  const globalConfig = path.join(root, 'global-config'); const attributes = path.join(home, 'empty-attributes');
  ensureEmpty(globalConfig); ensureEmpty(attributes);
  if (readdirSync(templateDirectory).length !== 0 || readdirSync(home).sort().join(',') !== 'empty-attributes') throw new SeedError('GIT_SEED_FAILED');
  console.info('[kogg:execution:git] environment.ready', { platform: 'linux', architecture: 'x64' });
  return new ControllerGitRunner('/usr/bin/git', { home, globalConfig, templateDirectory });
}

function ensureEmpty(file: string): void {
  try { writeFileSync(file, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const value = lstatSync(file); if (!value.isFile() || value.size !== 0 || value.uid !== process.geteuid?.()) throw new SeedError('GIT_SEED_FAILED');
  chmodSync(file, 0o600);
}
function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const value = lstatSync(directory);
  if (!value.isDirectory() || value.uid !== process.geteuid?.() || (value.mode & 0o077) !== 0) throw new SeedError('GIT_SEED_FAILED');
}
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
