// Public interface of the tenancy module. Other modules import only this file or `contracts/*`.
export { createTenant, tenantSummary, type CreateTenantInput } from './services/tenants';
export {
  addMember,
  changeMember,
  crmOwnerId,
  members,
  removeMember,
  setCrmOwnerIds,
  tenantsFor,
  userForCrmOwner,
} from './services/members';
export { ROLES, type Role, type Member, type DataLimit } from './contracts/members';
export { PERMISSIONS, ROLE_PERMISSIONS, isPermission, permissionsFor, type Permission } from './domain/permissions';
export { PERMISSION_LABELS, permissionLabel } from './domain/permission-labels';
export { DEFAULT_DATA_LIMIT, DataLimitSchema, defaultDataLimit, describeLimit, isWithin } from './domain/data-limit';
export { actorFor, can, describeAccess, requirePermission, type Principal } from './contracts/principal';
export { AUTH_PATHS, SIGN_IN_FAILED, auth, authHandler, type Auth } from './auth';
export {
  ACCOUNT_TURNED_OFF,
  NOT_SET_UP,
  checkSignIn,
  landingPathFor,
  signInEmailFor,
  type SignInIdentity,
  type EntraPolicy,
  type SignInResult,
} from './services/sign-in';
export { SESSION_IDLE_MS, sessionPrincipal, setPrincipalCacheTtl } from './services/principal';
export { handleDevSignIn } from './services/dev-sign-in';
export { SYSTEM_GRANTOR, createApiKey, createKeyFromCli, revokeActiveKeysNamed, revokeApiKey, type CreateApiKeyInput, type Grantor } from './services/api-keys';
export { resolvePrincipal } from './services/principal';
export { registerSourceValidator, type SourceValidator } from './contracts/source-validator';
export { listTenants, ensurePlatformAdmin, userIdForEmail, type TenantRow } from './services/tenants';
export { memberAccess, type MemberAccess } from './services/members';
export { devSignInUsers, type DevSignInUser } from './services/dev-sign-in';
export { sessionUser, type SessionUser } from './services/principal';
export { completeSignIn } from './services/sign-in';
