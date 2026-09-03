import type { CredentialMetadata, ModelDescriptor, ProviderDescriptor } from '@kogg/contracts';

export const KoggProviderServicePath = '/services/kogg-providers';

export type AccountLoginStatus = 'idle' | 'running' | 'awaiting-code' | 'succeeded' | 'failed' | 'cancelled';

export interface AccountLoginState {
    readonly status: AccountLoginStatus;
    readonly url?: string;
    readonly needsCode: boolean;
    readonly error?: string;
}
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
    startAccountLogin(provider: string, account: string): Promise<AccountLoginState>;
    accountLoginState(provider: string): Promise<AccountLoginState>;
    submitAccountLoginCode(provider: string, code: string): Promise<AccountLoginState>;
    cancelAccountLogin(provider: string): Promise<AccountLoginState>;
    deleteCredential(provider: string, account: string): Promise<boolean>;
    credentialStatus(provider: string, account: string): Promise<'configured' | 'missing'>;
    discoverModels(provider: string, account: string, endpoint?: string): Promise<readonly ModelDescriptor[]>;
    testConnection(provider: string, account: string, endpoint?: string): Promise<{ readonly ok: boolean; readonly detail: string }>;
    advisoryChat(request: AdvisoryChatRequest): Promise<string>;
}
