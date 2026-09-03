import type { CredentialMetadata, ModelDescriptor, ProviderDescriptor } from '@kogg/contracts';

export const KoggProviderServicePath = '/services/kogg-providers';
export const KoggProviderService = Symbol('KoggProviderService');

export interface AdvisoryChatRequest {
    readonly provider: string;
    readonly account: string;
    readonly endpoint?: string;
    readonly model: string;
    readonly prompt: string;
}

export interface KoggProviderService {
    listProviders(): Promise<readonly ProviderDescriptor[]>;
    listCredentialMetadata(): Promise<readonly CredentialMetadata[]>;
    configureCredential(provider: string, account: string, secret: string): Promise<void>;
    importAccountCredential(provider: string, account: string): Promise<void>;
    deleteCredential(provider: string, account: string): Promise<boolean>;
    credentialStatus(provider: string, account: string): Promise<'configured' | 'missing'>;
    discoverModels(provider: string, account: string, endpoint?: string): Promise<readonly ModelDescriptor[]>;
    testConnection(provider: string, account: string, endpoint?: string): Promise<{ readonly ok: boolean; readonly detail: string }>;
    advisoryChat(request: AdvisoryChatRequest): Promise<string>;
}
