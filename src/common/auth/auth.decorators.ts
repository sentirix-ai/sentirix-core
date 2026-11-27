import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/**
 * Marks a route or controller as publicly accessible without a Bearer JWT.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restricts route access to users carrying one of the specified roles.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
