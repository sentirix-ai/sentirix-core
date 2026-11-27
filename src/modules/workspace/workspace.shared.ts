import { ForbiddenException } from '@nestjs/common';

export interface WorkspaceMemberInfo {
  id: string;
  userId: string;
  fullName: string;
  username: string;
  role: string;
  joinedAt: Date | string;
  isOnline?: boolean;
  presenceStatus?: 'ONLINE' | 'TERPUTUS' | 'OFFLINE';
  token?: string | null;
  tokenIsUsed?: boolean;
  needsRegeneration?: boolean;
  freshTokenReady?: boolean;
}

export interface WorkspaceDetailResponse {
  workspaceId: string;
  name: string;
  ownerName: string;
  isLeader?: boolean;
  isQuotaLocked?: boolean;
  assignedQuota?: number;
  inviteToken: string;
  inviteUrl: string;
  isTokenUsed?: boolean;
  maxMembers: number;
  currentMembersCount: number;
  remainingSeats: number;
  members: WorkspaceMemberInfo[];
  pendingTokens?: Array<{
    id: string;
    token: string;
    role: string;
    createdAt: Date | string;
  }>;
}

const CORPORATE_ACRONYMS = new Set([
  'PT', 'CV', 'UD', 'TBK', 'LLC', 'LTD', 'GMBH', 'PTE', 'USA', 'UK', 'ID', 'BCA', 'BRI', 'BNI', 'IBM', 'AWS', 'NASA', 'SAP', 'AI', 'IT', 'HQ'
]);

export function formatCorporateTitleCase(input: string): string {
  if (!input) return '';
  const clean = input.trim().replace(/\s+/g, ' ');
  return clean
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (CORPORATE_ACRONYMS.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}


/**
 * Strips whitespace and trailing punctuation accidentally copied with invite tokens.
 */
export function sanitizeToken(raw?: string | null): string {
  return (raw || '').trim().replace(/[.,;:!?/\\'"]+$/, '').trim();
}

/**
 * Prevents the global Master Administrator from claiming team invite workspaces.
 */
export function assertNotAdmin(identifier: string): void {
  const clean = identifier.toLowerCase().trim();
  const adminUsername = (process.env.ADMIN_USERNAME || 'pungkyrama').toLowerCase().trim();
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@sevaniq.enterprise').toLowerCase().trim();
  if (clean === adminUsername || clean === adminEmail) {
    throw new ForbiddenException(
      'Master Administrator maintains global administrative privileges and does not use team invite links.',
    );
  }
}
