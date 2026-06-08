'use strict';

// How many presence calls to fire concurrently.
// Slack rate-limits users.getPresence at ~50 req/min (Tier 3).
// Batching at 10 keeps us well inside that even for large groups.
const PRESENCE_BATCH = 10;
const BATCH_DELAY_MS = 1200; // pause between batches

// Parse "(XX-YY)" or "(YY)" location tag from a display name.
// Returns the tag string (without parens) or null if absent.
function parseLocation(displayName) {
  const match = displayName && displayName.match(/\(([^)]+)\)$/);
  return match ? match[1] : null;
}

// Strip the location tag from the display name for cleaner display.
function strippedName(displayName) {
  return (displayName || '').replace(/\s*\([^)]+\)\s*$/, '').trim();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetch all user groups and find the one matching the handle.
async function resolveGroup(client, handle) {
  const result = await client.usergroups.list({ include_users: false });
  if (!result.ok) throw new Error('usergroups.list failed');

  const group = result.usergroups.find(
    (g) => g.handle.toLowerCase() === handle.toLowerCase()
  );
  if (!group) {
    const available = result.usergroups.map((g) => `@${g.handle}`).join(', ');
    const err = new Error(`Group not found: ${handle}`);
    err.userMessage = `No user group found matching *@${handle}*.\nAvailable groups: ${available || '(none)'}`;
    throw err;
  }
  return group;
}

// Fetch member user IDs for a group.
async function getGroupMembers(client, groupId) {
  const result = await client.usergroups.users.list({ usergroup: groupId });
  if (!result.ok) throw new Error('usergroups.users.list failed');
  return result.users; // array of user IDs
}

// Fetch full user profile for a single user ID.
async function getUserProfile(client, userId) {
  const result = await client.users.info({ user: userId, include_locale: false });
  if (!result.ok) return null;
  return result.user;
}

// Fetch presence for a single user ID.
async function getUserPresence(client, userId) {
  try {
    const result = await client.users.getPresence({ user: userId });
    return result.presence; // 'active' | 'away'
  } catch {
    return 'away';
  }
}

// Fetch profiles + presence for all members, respecting rate limits.
async function fetchMemberData(client, userIds) {
  // First: bulk-fetch all profiles (users.info is Tier 4, generous limit)
  const profiles = await Promise.all(userIds.map((id) => getUserProfile(client, id)));

  // Second: fetch presence in small batches to respect Tier 3 rate limit
  const presenceMap = {};
  for (let i = 0; i < userIds.length; i += PRESENCE_BATCH) {
    const batch = userIds.slice(i, i + PRESENCE_BATCH);
    const results = await Promise.all(
      batch.map(async (id) => ({ id, presence: await getUserPresence(client, id) }))
    );
    results.forEach(({ id, presence }) => { presenceMap[id] = presence; });
    if (i + PRESENCE_BATCH < userIds.length) await sleep(BATCH_DELAY_MS);
  }

  // Merge
  return userIds
    .map((id, idx) => {
      const user = profiles[idx];
      if (!user || user.deleted || user.is_bot) return null;

      const profile = user.profile || {};
      const displayName = user.profile?.display_name || user.real_name || id;
      const location = parseLocation(displayName);
      const name = strippedName(displayName);
      const statusEmoji = profile.status_emoji || '';
      const statusText = profile.status_text || '';
      const presence = presenceMap[id] || 'away';

      return { id, name, location, statusEmoji, statusText, presence };
    })
    .filter(Boolean);
}

// Build a single member row as a Block Kit section.
function memberBlock(member) {
  const presenceDot = member.presence === 'active' ? '🟢' : '⚫';
  const locationBadge = member.location ? ` *(${member.location})*` : '';
  const nameStr = `${presenceDot} ${member.name}${locationBadge}`;

  let statusStr = '';
  if (member.statusEmoji || member.statusText) {
    statusStr = [member.statusEmoji, member.statusText].filter(Boolean).join(' ');
  }

  return {
    type: 'section',
    fields: [
      {
        type: 'mrkdwn',
        text: nameStr,
      },
      {
        type: 'mrkdwn',
        text: statusStr || '—',
      },
    ],
  };
}

// Top-level: build the full Block Kit block array for the response.
async function buildPresenceBlocks(client, groupHandle) {
  const group = await resolveGroup(client, groupHandle);
  const userIds = await getGroupMembers(client, group.id);

  if (!userIds.length) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `No members found in *@${groupHandle}*.` },
      },
    ];
  }

  const members = await fetchMemberData(client, userIds);

  // Filter to active only, sort alpha
  const totalCount = members.length;
  const activeMembers = members
    .filter((m) => m.presence === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
  const activeCount = activeMembers.length;
  const ts = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  const blocks = [
    // Header
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `@${group.handle} — ${group.name}`,
        emoji: true,
      },
    },
    // Summary line
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🟢 *${activeCount} active* of ${totalCount} total  _(as of ${ts})_`,
      },
    },
    { type: 'divider' },
    // Column headers
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Name*' },
        { type: 'mrkdwn', text: '*Status*' },
      ],
    },
    { type: 'divider' },
    // One row per member
    ...activeMembers.map(memberBlock),
    // Footer
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Only visible to you · Run \`/whosonline ${groupHandle}\` again to refresh`,
        },
      ],
    },
  ];

  return blocks;
}

module.exports = { buildPresenceBlocks };
