/**
 * profileParser.ts
 * Parses Instagram profile data from embedded JSON blobs or DOM.
 *
 * Instagram's web_profile_info response (current as of 2024-2025):
 * {
 *   "data": {
 *     "user": {
 *       "username": "nike",
 *       "full_name": "Nike",
 *       "follower_count": 306000000,     <-- direct field (NOT edge_followed_by)
 *       "following_count": 168,          <-- direct field (NOT edge_follow)
 *       "media_count": 1234,             <-- direct field (NOT edge_owner_to_timeline_media)
 *       "is_verified": true,
 *       "profile_pic_url": "...",
 *       "profile_pic_url_hd": "...",
 *       "biography": "...",
 *       "id": "13460080",
 *       "pk": "13460080",
 *       ...
 *     }
 *   }
 * }
 */

export interface ParsedProfile {
  username: string;
  displayName: string | null;
  biography: string | null;
  profileImageUrl: string | null;
  followerCount: number | null;
  followingCount: number | null;
  totalPostCount: number | null;
  isVerified: boolean;
  externalId: string | null;
}

/**
 * Primary parser — handles the current web_profile_info API response shape.
 * Tries every known path across API versions.
 */
export function parseProfileFromApiResponse(apiData: any): ParsedProfile | null {
  if (!apiData) return null;

  // Try all known wrapping paths
  const candidates = [
    apiData?.data?.user,
    apiData?.graphql?.user,
    apiData?.user,
    apiData?.data?.xdt_api__v1__users__web_profile_info__connection?.user,
  ];

  for (const user of candidates) {
    if (user && (user.username || user.pk || user.id)) {
      return extractUserFields(user);
    }
  }

  // Deep-search for any object that looks like a user node
  const found = deepFindUser(apiData);
  if (found) return extractUserFields(found);

  return null;
}

/**
 * Handles legacy window._sharedData format.
 */
export function parseProfileFromSharedData(sharedData: any): ParsedProfile | null {
  try {
    const user =
      sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user ??
      sharedData?.entry_data?.ProfilePage?.[0]?.user;
    if (!user) return null;
    return extractUserFields(user);
  } catch {
    return null;
  }
}

/**
 * Handles __additionalDataLoaded / require() chunks.
 */
export function parseProfileFromRequireChunk(chunk: any): ParsedProfile | null {
  try {
    const candidates = [
      chunk?.data?.user,
      chunk?.user,
    ];

    for (const user of candidates) {
      if (user?.username) return extractUserFields(user);
    }

    const found = deepFindUser(chunk);
    if (found) return extractUserFields(found);

    return null;
  } catch {
    return null;
  }
}

function extractUserFields(user: any): ParsedProfile {
  // Instagram uses BOTH old graphql-style and new flat API style
  // We try both for every field and take whatever is non-null
  const followerCount =
    toNumber(user.follower_count) ??                      // new flat API
    toNumber(user.edge_followed_by?.count) ??             // old graphql
    toNumber(user.followers?.count) ??
    null;

  const followingCount =
    toNumber(user.following_count) ??                     // new flat API
    toNumber(user.edge_follow?.count) ??                  // old graphql
    toNumber(user.following?.count) ??
    null;

  const totalPostCount =
    toNumber(user.media_count) ??                         // new flat API
    toNumber(user.edge_owner_to_timeline_media?.count) ?? // old graphql
    toNumber(user.posts?.count) ??
    null;

  return {
    username: user.username ?? "",
    displayName: user.full_name ?? user.fullName ?? null,
    biography: user.biography ?? user.bio ?? null,
    profileImageUrl:
      user.profile_pic_url_hd ??
      user.profilePicUrlHd ??
      user.profile_pic_url ??
      user.profilePicUrl ??
      null,
    followerCount,
    followingCount,
    totalPostCount,
    isVerified: user.is_verified ?? user.isVerified ?? false,
    externalId: String(user.id ?? user.pk ?? ""),
  };
}

function toNumber(val: any): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

/**
 * Walk a JSON tree looking for a node that looks like an Instagram user object.
 * Stops at depth 6 to avoid excessive traversal.
 */
function deepFindUser(obj: any, depth = 0): any {
  if (depth > 6 || !obj || typeof obj !== "object") return null;

  // If this node looks like a user object, return it
  if (
    obj.username &&
    typeof obj.username === "string" &&
    (obj.follower_count !== undefined ||
      obj.edge_followed_by !== undefined ||
      obj.media_count !== undefined ||
      obj.is_verified !== undefined)
  ) {
    return obj;
  }

  // Recurse
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = deepFindUser(val, depth + 1);
      if (found) return found;
    }
  }

  return null;
}
