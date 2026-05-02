export interface SPAPICredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId: string;
}

export interface SyncResult {
  syncType: string;
  recordsFetched: number;
  errors: string[];
  duration: number;
}

export interface SyncStatus {
  running: boolean;
  results: SyncResult[];
  totalErrors: string[];
  startedAt: string;
  completedAt?: string;
}
