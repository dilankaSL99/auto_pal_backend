import type { UserTier } from '@prisma/client';
import { ApiError } from './errors';

// ── Tier limits ──────────────────────────────────────────────────────────────
// The single source of truth for what each subscription tier is allowed to do.
// These are plain config values — change a number here and every enforcement
// point (create routes, offline sync, backup import) picks it up. `null` means
// "no limit".
//
// NOTE ON DEFAULT TRACKERS: the app auto-seeds 7 default trackers on every new
// vehicle, so `maxTrackersPerVehicle` for free must stay >= 7 or a free user's
// first vehicle can't finish setting itself up. 7 == "the defaults, no customs".

export interface TierLimits {
  maxVehicles: number | null;
  maxTrackersPerVehicle: number | null;
  maxReminders: number | null;
  maxDocuments: number | null;
}

export const TIER_LIMITS: Record<UserTier, TierLimits> = {
  free: {
    maxVehicles: 1,
    maxTrackersPerVehicle: 7,
    maxReminders: 3,
    maxDocuments: 3,
  },
  pro: {
    maxVehicles: 10,
    maxTrackersPerVehicle: null,
    maxReminders: null,
    maxDocuments: null,
  },
};

export function limitsForTier(tier: UserTier): TierLimits {
  return TIER_LIMITS[tier] ?? TIER_LIMITS.free;
}

// ── Quota enforcement ────────────────────────────────────────────────────────
// Throws a 402 the client turns into a paywall. `currentCount` is the number of
// rows that already exist; the call is allowed to bring the total *up to* the
// limit (so a free user with a 7-tracker cap can create exactly 7).
//
// Over-limit accounts (e.g. data created before limits existed, or a lapsed Pro)
// are never broken: existing rows keep working; only *new* creates are blocked.
export function assertWithinLimit(
  currentCount: number,
  limit: number | null,
  resource: string,
  tier: UserTier,
): void {
  if (limit === null) return; // unlimited
  if (currentCount < limit) return; // room for one more
  throw new ApiError(
    402,
    upgradeMessage(resource, limit, tier),
    'UPGRADE_REQUIRED',
    { resource, limit, tier },
  );
}

function upgradeMessage(resource: string, limit: number, tier: UserTier): string {
  if (tier === 'free') {
    return `Your Free plan is limited to ${limit} ${resource}. Upgrade to Pro to add more.`;
  }
  return `You've reached the ${limit} ${resource} limit for your plan.`;
}
