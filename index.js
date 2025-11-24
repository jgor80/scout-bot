// index.js - ScoutBot (FC Pro Clubs Scouting)

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ApplicationCommandOptionType
} = require('discord.js');

const axios = require('axios');
const OpenAI = require('openai');

// -------------------- ENV VARS --------------------

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN env var not set');
  process.exit(1);
}

const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.warn('⚠️ OPENAI_API_KEY not set – scouting reports will fail.');
}
const openai = new OpenAI({ apiKey: openaiApiKey });

// -------------------- CONSTANTS --------------------

// FC web API platforms (what EA actually uses on proclubs.ea.com)
const FC_PLATFORMS = ['common-gen5', 'common-gen4'];

const FC_PLATFORM_LABELS = {
  'common-gen5': 'Gen 5 (PS5 / Xbox Series / PC)',
  'common-gen4': 'Gen 4 (PS4 / Xbox One)'
};

// Store pending choices per user for the select menu
// Map<userId, { query: string, results: Array<{ platform, clubId, name, region, division }> }>
const pendingScoutChoices = new Map();

// EA base + headers (mirrors your working curl as much as needed)
const EA_BASE_URL = 'https://proclubs.ea.com/api/fc';

const EA_HEADERS = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  dnt: '1',
  origin: 'https://www.ea.com',
  referer: 'https://www.ea.com/',
  'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/142.0.0.0 Safari/537.36'
};

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- EA HELPERS --------------------

async function eaGet(path, params = {}) {
  const url = `${EA_BASE_URL}${path}`;
  const res = await axios.get(url, {
    params,
    headers: EA_HEADERS,
    timeout: 8000
  });
  return res.data;
}

async function safeEaGet(path, params = {}, logLabel = '') {
  try {
    return await eaGet(path, params);
  } catch (err) {
    console.error(
      `⚠️ EA error for ${path}${logLabel ? ' ' + logLabel : ''}:`,
      err.toString()
    );
    return null;
  }
}

/**
 * Normalize a "club keyed" object (e.g. { "104358": {...} }) or array.
 */
function normalizeClubObject(data, clubId) {
  if (!data) return null;
  const idStr = String(clubId);
  if (Array.isArray(data)) {
    // Often single-element arrays
    return data[0] || null;
  }
  if (typeof data === 'object') {
    if (data[idStr]) return data[idStr];
    if (data[clubId]) return data[clubId];
    return data;
  }
  return data;
}

/**
 * Normalize matches result. FC endpoints might return:
 * - an array of matches
 * - or an object keyed by clubId with an array.
 */
function normalizeMatches(data, clubId) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  const idStr = String(clubId);
  if (Array.isArray(data[idStr])) return data[idStr];
  if (Array.isArray(data[clubId])) return data[clubId];

  // worst case – unknown shape, don't feed garbage
  console.warn('⚠️ Unexpected matches shape, skipping some data');
  return [];
}

// Generic helper to trim arrays
function trimArray(arr, max) {
  if (!Array.isArray(arr)) return arr;
  return arr.slice(0, max);
}

// Helper to safely JSON.stringify with character limit
function stringifyLimited(obj, label, maxChars) {
  try {
    const raw = JSON.stringify(obj);
    if (raw.length <= maxChars) return raw;
    return raw.slice(0, maxChars) + `...(truncated ${label})`;
  } catch (e) {
    console.warn(`⚠️ Failed to stringify ${label}:`, e.toString());
    return String(obj);
  }
}

// -------------------- CLUB SEARCH (allTimeLeaderboard/search) --------------------

/**
 * Search clubs by name across FC web platforms via allTimeLeaderboard/search.
 * Returns unique results: [{ platform, clubId, name, region, division }]
 */
async function searchClubsAcrossPlatforms(query) {
  const results = [];
  const q = query.trim();
  if (!q) return results;

  await Promise.all(
    FC_PLATFORMS.map(async (fcPlatform) => {
      try {
        const data = await eaGet('/allTimeLeaderboard/search', {
          platform: fcPlatform,
          clubName: q
        });

        if (!data) return;
        if (!Array.isArray(data)) {
          console.warn('⚠️ Unexpected leaderboard search shape:', data);
          return;
        }

        for (const row of data) {
          if (!row) continue;
          const clubId = String(row.clubId ?? row.clubInfo?.clubId ?? '');
          if (!clubId) continue;

          const name = row.clubName || row.clubInfo?.name || q;
          const division = row.currentDivision || row.bestDivision || null;

          // Region might not be present; keep null if missing
          const region =
            row.regionName ||
            row.clubInfo?.regionName ||
            row.region ||
            null;

          results.push({
            platform: fcPlatform, // FC web platform for API calls
            clubId,
            name,
            region,
            division
          });
        }
      } catch (err) {
        console.error(
          `⚠️ EA leaderboard search error platform=${fcPlatform}, query="${q}":`,
          err.toString()
        );
      }
    })
  );

  // Deduplicate by platform+clubId
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = `${r.platform}:${r.clubId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return unique;
}

// -------------------- OPENAI SCOUTING HELPERS --------------------

async function createScoutingReportFromId(fcPlatform, clubId, displayName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  // Pull as much team history + context as we reasonably can,
  // but we will trim before sending to OpenAI to avoid context overflow.
  const [
    infoRaw,
    overallStatsRaw,
    playoffAchievements,
    membersCareerStatsRaw,
    membersStatsRaw,
    leagueMatchesRaw,
    playoffMatchesRaw,
    friendlyMatchesRaw
  ] = await Promise.all([
    safeEaGet(
      '/clubs/info',
      {
        platform: fcPlatform,
        clubIds: clubId
      },
      `info clubId=${clubId}`
    ),
    safeEaGet(
      '/clubs/overallStats',
      {
        platform: fcPlatform,
        clubIds: clubId
      },
      `overallStats clubId=${clubId}`
    ),
    safeEaGet(
      '/club/playoffAchievements',
      {
        platform: fcPlatform,
        clubId
      },
      `playoffAchievements clubId=${clubId}`
    ),
    safeEaGet(
      '/members/career/stats',
      {
        platform: fcPlatform,
        clubId
      },
      `members/career/stats clubId=${clubId}`
    ),
    safeEaGet(
      '/members/stats',
      {
        platform: fcPlatform,
        clubId
      },
      `members/stats clubId=${clubId}`
    ),
    // History: league, playoff, friendlies – we'll hard-limit with maxResultCount
    safeEaGet(
      '/clubs/matches',
      {
        platform: fcPlatform,
        clubIds: clubId,
        matchType: 'leagueMatch',
        maxResultCount: 50
      },
      `matches leagueMatch clubId=${clubId}`
    ),
    safeEaGet(
      '/clubs/matches',
      {
        platform: fcPlatform,
        clubIds: clubId,
        matchType: 'playoffMatch',
        maxResultCount: 50
      },
      `matches playoffMatch clubId=${clubId}`
    ),
    safeEaGet(
      '/clubs/matches',
      {
        platform: fcPlatform,
        clubIds: clubId,
        matchType: 'friendlyMatch',
        maxResultCount: 50
      },
      `matches friendlyMatch clubId=${clubId}`
    )
  ]);

  const info = normalizeClubObject(infoRaw, clubId);
  const overallStats = normalizeClubObject(overallStatsRaw, clubId);

  const leagueMatchesAll = normalizeMatches(leagueMatchesRaw, clubId);
  const playoffMatchesAll = normalizeMatches(playoffMatchesRaw, clubId);
  const friendlyMatchesAll = normalizeMatches(friendlyMatchesRaw, clubId);

  // Trim big arrays to avoid blowing the context window
  const leagueMatches = trimArray(leagueMatchesAll, 30);    // last 30 league games
  const playoffMatches = trimArray(playoffMatchesAll, 20);  // last 20 playoffs
  const friendlyMatches = trimArray(friendlyMatchesAll, 20); // last 20 friendlies

  const membersCareerStats = Array.isArray(membersCareerStatsRaw)
    ? trimArray(membersCareerStatsRaw, 30) // top 30 players by whatever order EA gives
    : membersCareerStatsRaw;

  const membersStats = Array.isArray(membersStatsRaw)
    ? trimArray(membersStatsRaw, 30)
    : membersStatsRaw;

  // Pack stats together so GPT has a consistent structure
  const stats = {
    overallStats,
    playoffAchievements,
    membersCareerStats,
    membersStats
  };

  const matchesPayload = {
    leagueMatches,
    playoffMatches,
    friendlyMatches
  };

  // Hard limit JSON sizes before sending to OpenAI
  const infoStr = stringifyLimited(info ?? {}, 'club info', 8000);
  const statsStr = stringifyLimited(stats, 'club stats', 15000);
  const matchesStr = stringifyLimited(
    matchesPayload,
    'match history',
    25000
  );

  const inputText =
    `You are an experienced EA FC Pro Clubs tactical analyst. ` +
    `Given raw JSON stats and match history, write a concise scouting report for a competitive team.\n\n` +
    `Focus on:\n` +
    `- Overall quality & long-term record (league + playoffs + friendlies)\n` +
    `- Formation and playstyle tendencies (possession vs direct, wide/narrow, press/drop off)\n` +
    `- Key players and main threats (goals/assists, ratings, positions, consistency)\n` +
    `- Defensive tendencies & weaknesses (goals conceded patterns, clean sheets, discipline)\n` +
    `- Suggested game plan to beat them (what to target, what to avoid, recommended formations).\n\n` +
    `Club display name: ${displayName}\n` +
    `EA internal club ID: ${clubId}\n` +
    `FC web platform: ${fcPlatform}\n\n` +
    `Club info JSON (possibly truncated):\n${infoStr}\n\n` +
    `Club stats JSON (overall + players + playoffs, possibly truncated):\n${statsStr}\n\n` +
    `Match history JSON (league, playoff, friendlies; trimmed and possibly truncated):\n${matchesStr}\n\n` +
    `If some fields are missing or unclear, say that and base your analysis on what you do have. ` +
    `When you reference top performers, make sure they are actually among the best ` +
    `in the provided member stats (goals, assists, appearances, rating).`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content:
          'You are an EA FC Pro Clubs opposition scout. Always be clear, concise, and practical. ' +
          'Do not invent matches or players that are not supported by the JSON. ' +
          'If any JSON appears truncated, acknowledge that and work with what you see.'
      },
      {
        role: 'user',
        content: inputText
      }
    ]
  });

  const report = response.output_text || 'No report text returned.';
  return { info, report };
}

// -------------------- READY & COMMAND REGISTRATION --------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`✅ App ID: ${c.application.id}`);

  // Global command registration so it works on every server the bot is in
  await c.application.commands.set([
    {
      name: 'scoutclub',
      description:
        'Look up an EA FC Pro Clubs team by name & generate a scouting report.',
      options: [
        {
          name: 'name',
          description: 'Approximate club name as it appears in-game',
          type: ApplicationCommandOptionType.String,
          required: true
        }
      ]
    }
  ]);

  console.log('✅ Commands registered: /scoutclub (global)');
});

// -------------------- INTERACTION HANDLER --------------------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // /scoutclub – search FC leaderboard, let user pick a club, then generate report
      if (cmd === 'scoutclub') {
        const clubName = interaction.options.getString('name', true);

        await interaction.deferReply();

        const matches = await searchClubsAcrossPlatforms(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on EA FC servers. ' +
              'Try a different spelling or the full exact in-game name.'
          );
          return;
        }

        // If only one result, go straight to the report
        if (matches.length === 1) {
          const chosen = matches[0];
          const labelPlatform =
            FC_PLATFORM_LABELS[chosen.platform] || chosen.platform;

          await interaction.editReply(
            `Found one match: **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId}). Generating scouting report…`
          );

          try {
            const { info, report } = await createScoutingReportFromId(
              chosen.platform,
              chosen.clubId,
              chosen.name
            );

            const titleName = info?.name || chosen.name;
            const text = report || 'No report generated.';
            const trimmed =
              text.length > 4000 ? text.slice(0, 4000) + '…' : text;

            const embed = new EmbedBuilder()
              .setTitle(
                `Scouting report: ${titleName} (${labelPlatform}, ID: ${chosen.clubId})`
              )
              .setDescription(trimmed);

            await interaction.editReply({ content: null, embeds: [embed] });
          } catch (err) {
            console.error('❌ Error creating scouting report from ID:', err);
            await interaction.editReply(
              'I found the club, but failed to generate a scouting report (EA or OpenAI error).'
            );
          }

          return;
        }

        // Multiple results: let user choose via dropdown
        const top = matches.slice(0, 5);
        pendingScoutChoices.set(interaction.user.id, {
          query: clubName,
          results: top
        });

        const options = top.map((club, index) => {
          const labelPlatform =
            FC_PLATFORM_LABELS[club.platform] || club.platform;
          const labelRegion = club.region ? ` – ${club.region}` : '';
          const labelDivision = club.division
            ? ` – Div ${club.division}`
            : '';

          return {
            label: `${club.name} (${labelPlatform})`,
            description: `${labelPlatform}${labelRegion}${labelDivision}`.slice(
              0,
              100
            ),
            value: String(index)
          };
        });

        const select = new StringSelectMenuBuilder()
          .setCustomId('scoutclub_pick')
          .setPlaceholder('Select the correct club')
          .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);

        const lines = top.map((club, index) => {
          const labelPlatform =
            FC_PLATFORM_LABELS[club.platform] || club.platform;
          const parts = [labelPlatform];
          if (club.region) parts.push(club.region);
          if (club.division) parts.push(`Div ${club.division}`);
          const extra = parts.length ? ' – ' + parts.join(' / ') : '';
          return `**${index + 1}.** ${club.name}${extra}`;
        });

        const embed = new EmbedBuilder()
          .setTitle('Multiple clubs found')
          .setDescription(
            lines.join('\n') +
              '\n\nUse the dropdown below to pick the club you want to scout.'
          );

        await interaction.editReply({
          content: null,
          embeds: [embed],
          components: [row]
        });

        return;
      }
    }

    // Select menu: user picks which club to scout
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'scoutclub_pick') {
        const userId = interaction.user.id;
        const state = pendingScoutChoices.get(userId);

        if (!state) {
          return interaction.reply({
            content:
              'No pending club selection found. Please run `/scoutclub` again.',
            ephemeral: true
          });
        }

        const index = parseInt(interaction.values[0], 10);
        const chosen = state.results[index];
        if (!chosen) {
          return interaction.reply({
            content: 'Invalid club selection. Please run `/scoutclub` again.',
            ephemeral: true
          });
        }

        // Remove pending state so we don't reuse it accidentally
        pendingScoutChoices.delete(userId);

        const labelPlatform =
          FC_PLATFORM_LABELS[chosen.platform] || chosen.platform;

        // Acknowledge quickly, then do the heavy work
        await interaction.deferUpdate();

        // Update the original message to show that we're working
        await interaction.editReply({
          content: `Generating scouting report for **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId})…`,
          embeds: [],
          components: []
        });

        try {
          const { info, report } = await createScoutingReportFromId(
            chosen.platform,
            chosen.clubId,
            chosen.name
          );

          const titleName = info?.name || chosen.name;
          const text = report || 'No report generated.';
          const trimmed =
            text.length > 4000 ? text.slice(0, 4000) + '…' : text;

          const embed = new EmbedBuilder()
            .setTitle(
              `Scouting report: ${titleName} (${labelPlatform}, ID: ${chosen.clubId})`
            )
            .setDescription(trimmed);

          await interaction.editReply({ content: null, embeds: [embed] });
        } catch (err) {
          console.error('❌ Error creating scouting report (select):', err);
          await interaction.editReply({
            content:
              'I found the club, but failed to generate a scouting report (EA or OpenAI error).',
            embeds: [],
            components: []
          });
        }

        return;
      }
    }
  } catch (err) {
    console.error('❌ Error handling interaction:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Error.',
        ephemeral: true
      });
    }
  }
});

// -------------------- LOGIN --------------------

client.login(token);
