import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileUri } from '@theia/core/lib/node';
import { injectable } from '@theia/core/shared/inversify';
import { ProjectError } from './project-errors';

// diagnostic-coverage: projects.registry, projects.restoration

@injectable()
export class ProjectWorkspaceProjection {
  private readonly directory = path.join(stateRoot(), 'projects', 'workspaces');

  async write(projectId: string, repositoryUris: readonly string[]): Promise<string> {
    console.info('[kogg:projects:workspace] projection.started', { projectId, repositoryCount: repositoryUris.length });
    const destination = this.path(projectId);
    const temporary = path.join(this.directory, `.${projectId}.${randomUUID()}.tmp`);
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const document = {
        'kogg-project-workspace-version': 1,
        folders: [...repositoryUris].sort().map(uri => ({ path: uri }))
      };
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(document, undefined, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, destination);
      await syncDirectory(this.directory);
      console.info('[kogg:projects:workspace] projection.completed', { projectId, repositoryCount: repositoryUris.length });
      return FileUri.create(destination).toString();
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      console.error('[kogg:projects:workspace] projection.failed', {
        projectId,
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      throw new ProjectError('PROJECT_WORKSPACE_PROJECTION_FAILED', 'Kogg could not prepare the project workspace.', { cause: error });
    }
  }

  async remove(projectId: string): Promise<void> {
    console.info('[kogg:projects:workspace] projection-cleanup.started', { projectId });
    try {
      await fs.unlink(this.path(projectId)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      console.info('[kogg:projects:workspace] projection-cleanup.completed', { projectId });
    } catch (error) {
      console.error('[kogg:projects:workspace] projection-cleanup.failed', {
        projectId,
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      throw new ProjectError('PROJECT_WORKSPACE_PROJECTION_FAILED', 'Kogg could not clean up the project workspace.', { cause: error });
    }
  }

  uri(projectId: string): string {
    return FileUri.create(this.path(projectId)).toString();
  }

  private path(projectId: string): string {
    return path.join(this.directory, `${projectId}.theia-workspace`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function stateRoot(): string {
  const root = process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd();
  return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(root, '.kogg', 'state'));
}
