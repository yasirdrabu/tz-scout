// Public interface of the integrations module. Other modules import only this file or `contracts/*`.
export { gateway, RateLimitedError, redactSummary, type CallOpts } from './gateway';
export {
  CREDENTIAL_KINDS,
  HINT_MIN_LENGTH,
  NOT_LIVE_YET,
  SAMPLE_ONLY,
  TEST_FIRST,
  connectionSettings,
  connectionStatus,
  listConnections,
  recentCalls,
  saveCredential,
  setConnectionSettings,
  setDisabled,
  setMode,
  testConnection,
  type CallView,
  type ConnectionMode,
  type ConnectionStatus,
  type ConnectionView,
  type CredentialKind,
} from './services/connections';
export {
  PROVIDERS,
  registerAdapter,
  type Adapter,
  type AdapterFactories,
  type LiveCredentials,
  type Provider,
  type TestResult,
} from './providers';
export { MASTER_KEY_MISSING } from './services/vault';
export { credentialsCleanupHandler, credentialsCleanupJob } from './jobs';
