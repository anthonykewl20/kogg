import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import keytar from 'keytar';
import { injectable } from 'inversify';
import type { CredentialMetadata, CredentialStore } from '@kogg/contracts';

interface EncryptedRecord {
    readonly iv: string;
    readonly ciphertext: string;
    readonly tag: string;
    readonly updatedAt: string;
}

type EncryptedFile = Record<string, EncryptedRecord>;

function recordKey(provider: string, account: string): string {
    return `${encodeURIComponent(provider)}:${encodeURIComponent(account)}`;
}

function splitRecordKey(key: string): [string, string] {
    const separator = key.indexOf(':');
    return [decodeURIComponent(key.slice(0, separator)), decodeURIComponent(key.slice(separator + 1))];
}

@injectable()
export class ElectronCredentialStore implements CredentialStore {
    private readonly service = 'Kogg AI Providers';

    async set(provider: string, account: string, secret: string): Promise<void> {
        await keytar.setPassword(this.service, recordKey(provider, account), secret);
        await this.writeMetadata(provider, account);
    }

    async get(provider: string, account: string): Promise<string | undefined> {
        return (await keytar.getPassword(this.service, recordKey(provider, account))) ?? undefined;
    }

    async delete(provider: string, account: string): Promise<boolean> {
        const deleted = await keytar.deletePassword(this.service, recordKey(provider, account));
        const metadata = await this.readMetadata();
        delete metadata[recordKey(provider, account)];
        await this.saveMetadata(metadata);
        return deleted;
    }

    async listMetadata(): Promise<CredentialMetadata[]> {
        const metadata = await this.readMetadata();
        return Object.entries(metadata).map(([key, updatedAt]) => {
            const [provider, account] = splitRecordKey(key);
            return { provider, account, updatedAt };
        });
    }

    private async writeMetadata(provider: string, account: string): Promise<void> {
        const metadata = await this.readMetadata();
        metadata[recordKey(provider, account)] = new Date().toISOString();
        await this.saveMetadata(metadata);
    }

    private async readMetadata(): Promise<Record<string, string>> {
        try {
            return JSON.parse(await fs.readFile(this.metadataPath(), 'utf8')) as Record<string, string>;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw error;
        }
    }

    private async saveMetadata(metadata: Record<string, string>): Promise<void> {
        await fs.mkdir(path.dirname(this.metadataPath()), { recursive: true, mode: 0o700 });
        await fs.writeFile(this.metadataPath(), JSON.stringify(metadata), { mode: 0o600 });
    }

    private metadataPath(): string {
        return path.join(stateRoot(), 'credentials', 'electron-metadata.json');
    }
}

@injectable()
export class BrowserCredentialStore implements CredentialStore {
    async set(provider: string, account: string, secret: string): Promise<void> {
        const records = await this.read();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.masterKey(), iv);
        const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
        records[recordKey(provider, account)] = {
            iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'), updatedAt: new Date().toISOString()
        };
        await this.write(records);
    }

    async get(provider: string, account: string): Promise<string | undefined> {
        const record = (await this.read())[recordKey(provider, account)];
        if (!record) return undefined;
        const decipher = createDecipheriv('aes-256-gcm', this.masterKey(), Buffer.from(record.iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
        return Buffer.concat([
            decipher.update(Buffer.from(record.ciphertext, 'base64url')),
            decipher.final()
        ]).toString('utf8');
    }

    async delete(provider: string, account: string): Promise<boolean> {
        const records = await this.read();
        const key = recordKey(provider, account);
        const existed = Boolean(records[key]);
        delete records[key];
        await this.write(records);
        return existed;
    }

    async listMetadata(): Promise<CredentialMetadata[]> {
        return Object.entries(await this.read()).map(([key, record]) => {
            const [provider, account] = splitRecordKey(key);
            return { provider, account, updatedAt: record.updatedAt };
        });
    }

    private masterKey(): Buffer {
        const supplied = process.env.KOGG_MASTER_KEY;
        if (!supplied) throw new Error('KOGG_MASTER_KEY is mandatory in browser mode');
        return createHash('sha256').update(supplied, 'utf8').digest();
    }

    private async read(): Promise<EncryptedFile> {
        try {
            return JSON.parse(await fs.readFile(this.filePath(), 'utf8')) as EncryptedFile;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw error;
        }
    }

    private async write(records: EncryptedFile): Promise<void> {
        const destination = this.filePath();
        const temporary = `${destination}.partial-${process.pid}`;
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
        await fs.rename(temporary, destination);
    }

    private filePath(): string {
        return path.join(stateRoot(), 'credentials', 'browser.enc.json');
    }
}

function stateRoot(): string {
    return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state'));
}
