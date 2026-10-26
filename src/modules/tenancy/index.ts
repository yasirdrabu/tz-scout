// Public interface of the tenancy module. Other modules import only this file or `contracts/*`.
export { createTenant, type CreateTenantInput } from './services/tenants';
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
export { DEFAULT_DATA_LIMIT, DataLimitSchema, defaultDataLimit, describeLimit } from './domain/data-limit';
export { can, describeAccess, requirePermission, type Principal } from './contracts/principal';
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
