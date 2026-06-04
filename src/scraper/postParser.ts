/**
 * postParser.ts
 * Parses Instagram post/media data from multiple API response shapes.
 *
 * Current Instagram response paths (2024-2025):
 *
 * 1. web_profile_info ALSO includes posts in:
 *    data.user.edge_owner_to_timeline_media.edges[].node
 *
 * 2. Newer xdt GraphQL path:
 *    data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[].node
 *
 * 3. Internal feed API (/api/v1/feed/user/):
 *    items[].  (each item is a post)
 *
 * 4. graphql/query:
 *    data.user.edge_owner_to_timeline_media.edges[].node
 */

export interface ParsedPost {
  shortCode: string;
  postUrl: string;
  caption: string | null;
  mediaType: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  likesCount: number | null;
  commentsCount: number | null;
  viewsCount: number | null;
  publishedAt: Date | null;
}

// ─── Public entry points ──────────────────────────────────────────────────────

/**
 * Extract posts from ANY captured API response.
 * Tries every known path. Returns empty array if nothing found.
 */
export function extractPostsFromAnyResponse(body: any): ParsedPost[] {
  if (!body) return [];
  const posts: ParsedPost[] = [];

  // Path 1: web_profile_info — user.edge_owner_to_timeline_media.edges
  const edges1 = body?.data?.user?.edge_owner_to_timeline_media?.edges;
  if (Array.isArray(edges1) && edges1.length > 0) {
    console.log(`[PostParser] Found ${edges1.length} posts via edge_owner_to_timeline_media`);
    posts.push(...parsePostsFromEdges(edges1));
  }

  // Path 2: xdt_api GraphQL connection
  const edges2 =
    body?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges ??
    body?.data?.xdt_api__v1__media__shortcode__web_info?.edges;
  if (Array.isArray(edges2) && edges2.length > 0) {
    console.log(`[PostParser] Found ${edges2.length} posts via xdt_api`);
    posts.push(...parsePostsFromEdges(edges2));
  }

  // Path 3: graphql/query with data.user
  const edges3 = body?.graphql?.user?.edge_owner_to_timeline_media?.edges;
  if (Array.isArray(edges3) && edges3.length > 0) {
    console.log(`[PostParser] Found ${edges3.length} posts via graphql.user`);
    posts.push(...parsePostsFromEdges(edges3));
  }

  // Path 4: /api/v1/feed/user/ items[]
  if (Array.isArray(body?.items) && body.items.length > 0) {
    console.log(`[PostParser] Found ${body.items.length} posts via feed items`);
    posts.push(...parsePostsFromFeedItems(body.items));
  }

  // Path 5: bare edges[] at top level
  if (Array.isArray(body?.edges) && body.edges.length > 0) {
    posts.push(...parsePostsFromEdges(body.edges));
  }

  return posts;
}

/**
 * Parse posts from graphql edge format: edges[].node
 */
export function parsePostsFromEdges(edges: any[]): ParsedPost[] {
  if (!Array.isArray(edges)) return [];
  const posts: ParsedPost[] = [];
  for (const edge of edges) {
    try {
      const node = edge?.node ?? edge;
      const post = parseGraphQLNode(node);
      if (post) posts.push(post);
    } catch {
      // Skip broken nodes
    }
  }
  return posts;
}

/**
 * Parse posts from /api/v1/feed/user/ items[] format.
 */
export function parsePostsFromFeedItems(items: any[]): ParsedPost[] {
  if (!Array.isArray(items)) return [];
  const posts: ParsedPost[] = [];
  for (const item of items) {
    try {
      const post = parseFeedItem(item);
      if (post) posts.push(post);
    } catch {
      // Skip broken items
    }
  }
  return posts;
}

// ─── Private parsers ──────────────────────────────────────────────────────────

function parseGraphQLNode(node: any): ParsedPost | null {
  if (!node) return null;

  const shortCode =
    node.shortcode ?? node.short_code ?? node.code ?? null;
  if (!shortCode) return null;

  const typename = node.__typename ?? node.media_type_name ?? "";
  const mediaType = resolveMediaTypeFromTypename(typename) ??
    resolveMediaTypeFromInt(node.media_type) ??
    "IMAGE";

  const timestamp =
    node.taken_at_timestamp ??
    node.taken_at ??
    node.timestamp ??
    null;

  const caption =
    node.edge_media_to_caption?.edges?.[0]?.node?.text ??
    node.caption?.text ??
    (typeof node.caption === "string" ? node.caption : null) ??
    null;

  return {
    shortCode,
    postUrl: `https://www.instagram.com/p/${shortCode}/`,
    caption,
    mediaType,
    mediaUrl: pickMediaUrl(node, mediaType),
    thumbnailUrl:
      node.thumbnail_src ??
      node.display_url ??
      node.thumbnail_resources?.slice(-1)?.[0]?.src ??
      null,
    likesCount:
      toNumber(node.edge_liked_by?.count) ??
      toNumber(node.edge_media_preview_like?.count) ??
      toNumber(node.like_count) ??
      null,
    commentsCount:
      toNumber(node.edge_media_to_comment?.count) ??
      toNumber(node.edge_media_preview_comment?.count) ??
      toNumber(node.comment_count) ??
      null,
    viewsCount:
      toNumber(node.video_view_count) ??
      toNumber(node.view_count) ??
      null,
    publishedAt: timestamp
      ? new Date(Number(timestamp) * 1000)
      : null,
  };
}

function parseFeedItem(item: any): ParsedPost | null {
  if (!item) return null;

  const shortCode = item.code ?? item.shortcode ?? null;
  if (!shortCode) return null;

  const mediaType =
    resolveMediaTypeFromInt(item.media_type) ??
    resolveMediaTypeFromTypename(item.__typename ?? "") ??
    "IMAGE";

  const timestamp = item.taken_at ?? item.taken_at_timestamp ?? null;

  let caption: string | null = null;
  if (typeof item.caption === "string") {
    caption = item.caption;
  } else if (item.caption?.text) {
    caption = item.caption.text;
  } else if (Array.isArray(item.edge_media_to_caption?.edges)) {
    caption = item.edge_media_to_caption.edges[0]?.node?.text ?? null;
  }

  return {
    shortCode,
    postUrl: `https://www.instagram.com/p/${shortCode}/`,
    caption,
    mediaType,
    mediaUrl: pickMediaUrl(item, mediaType),
    thumbnailUrl:
      item.thumbnail_url ??
      item.image_versions2?.candidates?.[0]?.url ??
      item.display_url ??
      null,
    likesCount:
      toNumber(item.like_count) ??
      toNumber(item.edge_liked_by?.count) ??
      null,
    commentsCount:
      toNumber(item.comment_count) ??
      toNumber(item.edge_media_to_comment?.count) ??
      null,
    viewsCount:
      toNumber(item.view_count) ??
      toNumber(item.video_view_count) ??
      null,
    publishedAt: timestamp
      ? new Date(Number(timestamp) * 1000)
      : null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveMediaTypeFromTypename(typename: string): string | null {
  switch (typename) {
    case "GraphVideo":
    case "XDTGraphVideo":
    case "video": return "VIDEO";
    case "GraphSidecar":
    case "XDTGraphSidecar":
    case "CAROUSEL_ALBUM":
    case "carousel": return "CAROUSEL_ALBUM";
    case "GraphImage":
    case "XDTGraphImage":
    case "image": return "IMAGE";
    default: return null;
  }
}

function resolveMediaTypeFromInt(mediaType: number | undefined): string | null {
  // Instagram internal: 1=photo, 2=video, 8=album
  switch (mediaType) {
    case 1: return "IMAGE";
    case 2: return "VIDEO";
    case 8: return "CAROUSEL_ALBUM";
    default: return null;
  }
}

function pickMediaUrl(node: any, mediaType: string): string | null {
  if (mediaType === "VIDEO") {
    return (
      node.video_url ??
      node.video_versions?.[0]?.url ??
      node.display_url ??
      null
    );
  }
  return (
    node.display_url ??
    node.image_versions2?.candidates?.[0]?.url ??
    node.thumbnail_src ??
    null
  );
}

function toNumber(val: any): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}
