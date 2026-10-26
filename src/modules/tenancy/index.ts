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
