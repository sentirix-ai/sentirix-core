import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const IS_SUPER_ADMIN_ROUTE_KEY = 'isSuperAdminRoute';

/**
 * Marks a route or controller as publicly accessible without a Bearer JWT.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restricts route access to users carrying one of the specified tenant/staff roles.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Isolates a route or controller exclusively to the Platform Founder (SUPER_ADMIN)
 * authenticated via SUPER_ADMIN_JWT_SECRET.
 */
export const SuperAdminOnly = () => SetMetadata(IS_SUPER_ADMIN_ROUTE_KEY, true);
