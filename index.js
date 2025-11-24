// index.js – ScoutBot (FC Pro Clubs Scouting)

/* -------------------- IMPORTS -------------------- */

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

/* -------------------- ENV VARS -------------------- */

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

/* -------------------- CONSTANTS -------------------- */

// FC platforms to try when searching leaderboard
const FC_PLATFORMS = [
  'common-gen5',
  'common-gen4',
  'ps5',
  'ps4',
  'xbox-series-xs',
  'xboxone'
];

const PLATFORM_LABELS = {
  'common-gen5': 'Cross-gen (Gen5)',
  'common-gen4': 'Cross-gen (Gen4)',
  ps5: 'PlayStation 5',
  ps4: 'PlayStation 4',
  'xbox-series-xs': 'Xbox Series X|S',
  xboxone: 'Xbox One',
  pc: 'PC'
};

// Headers to make EA think we’re a normal browser
const EA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  accept: 'application/json',
  DNT: '1',
  origin: 'https://www.ea.com',
  referer: 'https://www.ea.com/',
  'sec-ch-ua-platform': '"Windows"'
};

// Store pending choices per user for the select menu
// Map<userId, { query: string, results: Array<{ fcPlatform, clubId, name, division, wins, losses, ties }> }>
const pendingScoutChoices = new Map();

/* -------------------- DISCORD CLIENT -------------------- */

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* -------------------- OPENAI PROMPTS -------------------- */

const SYSTEM_PROMPT = `
You are an experienced EA FC Pro Clubs opposition scout.

You will receive:
- Club info JSON for a single team
- Aggregated club + player stats JSON
- Match history JSON for league, playoffs, and friendlies (trimmed and sometimes truncated)

Your job: produce a concise, practical scouting report for a competitive Pro Clubs team.

### Core behavior

- Be **data-driven**: base all claims on the numbers and fields you actually see.
- Make **inferences**, but never pure guesses. If something is uncertain, say it is *likely* or *appears to* based on the data.
- **Do not invent**:
  - Do not invent player names, positions, or stats that do not appear in the JSON.
  - Do not invent formations or tactics that are not clearly implied by the events / stats.
- If the JSON looks **truncated** or incomplete, treat it as partial data and say that.
- If certain stats are **missing**, explicitly say that they are missing instead of making them up.

### How to use the data

You’ll see three logical chunks of JSON:
1. **Club info JSON** – identity, platform, region, maybe current division, etc.
2. **Stats JSON** – may include:
   - Overall club stats (long-term record: wins, losses, goals for/against, clean sheets, divisions, promotions/relegations)
   - Playoff achievements
   - Per-player stats (career stats and/or season stats: games, goals, assists, rating, positions if available)
3. **Match history JSON** – grouped into:
   - League matches (recent league performance)
   - Playoff matches (high-pressure matches)
   - Friendly matches (often used for competitive scrims and tournaments; treat these as **highly relevant** for tactics and game plans when the sample is strong).

When reasoning:
- Use overall stats for **big-picture quality** and long-term strengths/weaknesses.
- Use match history (league + playoff + friendly) for **recent form** and **patterns** (e.g., always concede late, win big, high-scoring games, etc.) *only if the data clearly supports it*.
- If there is a **large or recent friendly sample**, treat friendly matches as a strong indicator of tournament-style behavior and give them extra weight in your tactical conclusions.
- Use player stats to identify **key attackers**, **playmakers**, and **defensive anchors**. Only call someone a “key player” if their stats clearly stand out (more games, more goals/assists, higher ratings, etc.).

If timestamps, seasons, or ordering fields are present:
- You may comment on trends over time (e.g. “recently improved”, “current slump”).
If there is no clear chronological indicator:
- Do NOT talk about “early season” vs “late season” or detailed time trends; just talk about patterns across the supplied sample.

### Style & structure

- Address the report to a **coach preparing to play (or join) this team**.
- Be **clear, concise, and practical**.
- Do **not** mention JSON, fields, or technical details. Just talk football.
- Avoid filler and hype. Focus on what a serious competitive team would care about.

Organize the report with headings like:

1. **Overall Summary**
   - Short paragraph with overall quality, rough level, and identity.

2. **Attacking Tendencies**
   - How often they score.
   - Whether they seem direct vs possession-based (if shot counts, pass counts, or relevant stats exist).
   - Preferred threats: through the middle vs wide, headers vs long shots, etc. (only if supported).
   - Where helpful, explicitly distinguish what you see in **league** vs **friendly** games (e.g., more open high-scoring friendlies).

3. **Defensive Tendencies**
   - Goals conceded, clean sheet rate.
   - Patterns: concede early/late, vulnerable to counters, weak defending crosses, etc. (only if supported).
   - Discipline if cards/fouls are present.
   - Call out any differences you see between league and friendly/playoff matches (for example, more open or weaker defending in friendlies).

4. **Key Players & Roles**
   - 3–6 standout players, with:
     - Their apparent position or role (inferred from stats or any position fields).
     - Why they are important (goals, assists, games played, rating, etc.).
   - Do not list every player. Focus on the clearest standouts.

5. **Recent Form & Mentality**
   - Use the most recent slice of **league, playoff, and friendly** matches provided.
   - Win/loss tendencies, blowouts vs tight games, comebacks/choking if the data supports it.
   - Explicitly mention if friendlies suggest a different mentality (for example, more experimental lineups vs serious tournament-style friendlies).

6. **Game Plan to Beat Them**
   - Make this section **as specific and concrete as possible**, but only when the data clearly supports it.
   - Tie every recommendation to observed patterns, for example:
     - If they concede many goals from crosses or headers, suggest overloading wide areas and attacking the back post.
     - If they score many counterattack goals with a specific striker, suggest a deeper line or dedicated cover.
     - If they struggle in close games or concede late, suggest sustained pressure late in each half.
     - If friendlies show different behavior than league (e.g. more aggressive press, different formation), highlight this and explain how to exploit it in **tournament-style matches**.
   - Avoid generic advice like “play your game” or “just focus”; every point should be clearly linked to a real tendency in the data.

7. **Uncertainties & Data Gaps (if needed)**
   - Briefly list anything that limits confidence (missing stats, truncated history, few matches, etc.).

Keep the entire report **under ~3500 characters** if possible, but do not sacrifice important insights to be shorter.
`;

function buildUserPrompt({
  displayName,
  clubId,
  fcPlatform,
  infoStr,
  statsStr,
  matchesStr
}) {
  return `
You are analyzing a single EA FC Pro Clubs team.

High-level identifiers:
- Club display name: ${displayName}
- EA internal club ID: ${clubId}
- FC web platform: ${fcPlatform}

You are given three JSON blobs as plain text:

1) CLUB_INFO_JSON
--------------------------------
${infoStr}

2) STATS_JSON (overall + players + playoffs)
--------------------------------
${statsStr}

3) MATCH_HISTORY_JSON (league, playoff, friendly)
--------------------------------
${matchesStr}

Instructions:

- Treat these blobs as your only source of truth.
- Only talk about players, stats, and patterns that you can reasonably derive from these JSON structures.
- Give **particular attention** to patterns that appear in friendly matches, because those are often used as tournament-style games. If friendlies provide a larger or more recent sample, you should lean on them heavily for inferring tactics and mentality.
- If any of the JSON is clearly partial or truncated, treat that section as partial data.
- If something important (like positions, cards, or timestamps) is missing, acknowledge that briefly instead of guessing.

Now, using ONLY this data, write the scouting report as described in the system message. Do not restate the raw JSON; just output the final report with the requested headings and football analysis.`;
}

/* -------------------- EA HELPERS -------------------- */

// Search clubs using the FC all-time leaderboard endpoint across multiple platforms
async function searchClubsByName(query) {
  const q = query.trim();
  if (!q) return [];

  const results = [];

  await Promise.all(
    FC_PLATFORMS.map(async (platform) => {
      try {
        const res = await axios.get(
          'https://proclubs.ea.com/api/fc/allTimeLeaderboard/search',
          {
            params: {
              platform,
              clubName: q
            },
            headers: EA_HEADERS,
            timeout: 8000
          }
        );

        const data = res.data;
        let items;

        if (Array.isArray(data)) {
          items = data;
        } else if (Array.isArray(data?.entries)) {
          items = data.entries;
        } else {
          console.warn('⚠️ Unexpected leaderboard search shape:', data);
          return;
        }

        for (const item of items) {
          if (!item) continue;
          const clubId =
            String(item.clubId ?? item.clubInfo?.clubId ?? '').trim();
          if (!clubId) continue;

          results.push({
            fcPlatform: item.platform || platform,
            clubId,
            name: item.clubName || item.clubInfo?.name || q,
            currentDivision: item.currentDivision || item.bestDivision || null,
            wins: item.wins ?? null,
            losses: item.losses ?? null,
            ties: item.ties ?? null,
            gamesPlayed: item.gamesPlayed ?? null,
            goals: item.goals ?? null,
            goalsAgainst: item.goalsAgainst ?? null,
            raw: item
          });
        }
      } catch (err) {
        console.error(
          `⚠️ EA leaderboard search error for platform=${platform}, query="${q}":`,
          err.toString()
        );
      }
    })
  );

  // Deduplicate by platform+clubId
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = `${r.fcPlatform}:${r.clubId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return unique;
}

// Fetch detailed club data from FC endpoints
async function fetchClubData(fcPlatform, clubId, leaderboardSeed = null) {
  const platform = fcPlatform || 'common-gen5';
  const clubIdsParam = String(clubId);

  const baseParams = { platform };
  const clubParams = { ...baseParams, clubIds: clubIdsParam };
  const singleClubParams = { ...baseParams, clubId: clubIdsParam };

  const requests = {
    info: axios.get('https://proclubs.ea.com/api/fc/clubs/info', {
      params: clubParams,
      headers: EA_HEADERS,
      timeout: 8000
    }),
    overallStats: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/overallStats',
      {
        params: clubParams,
        headers: EA_HEADERS,
        timeout: 8000
      }
    ),
    playoffAchievements: axios.get(
      'https://proclubs.ea.com/api/fc/club/playoffAchievements',
      {
        params: singleClubParams,
        headers: EA_HEADERS,
        timeout: 8000
      }
    ),
    membersCareer: axios.get(
      'https://proclubs.ea.com/api/fc/members/career/stats',
      {
        params: singleClubParams,
        headers: EA_HEADERS,
        timeout: 8000
      }
    ),
    membersSeason: axios.get('https://proclubs.ea.com/api/fc/members/stats', {
      params: singleClubParams,
      headers: EA_HEADERS,
      timeout: 8000
    }),
    leagueMatches: axios.get('https://proclubs.ea.com/api/fc/clubs/matches', {
      params: {
        ...clubParams,
        matchType: 'leagueMatch',
        maxResultCount: 50
      },
      headers: EA_HEADERS,
      timeout: 10000
    }),
    playoffMatches: axios.get('https://proclubs.ea.com/api/fc/clubs/matches', {
      params: {
        ...clubParams,
        matchType: 'playoffMatch',
        maxResultCount: 50
      },
      headers: EA_HEADERS,
      timeout: 10000
    }),
    friendlyMatches: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/matches',
      {
        params: {
          ...clubParams,
          matchType: 'friendlyMatch',
          maxResultCount: 50
        },
        headers: EA_HEADERS,
        timeout: 10000
      }
    )
  };

  const [
    infoRes,
    overallRes,
    playoffRes,
    careerRes,
    seasonRes,
    leagueRes,
    playoffMatchesRes,
    friendlyRes
  ] = await Promise.allSettled(Object.values(requests));

  function safeData(settled) {
    if (settled.status === 'fulfilled') return settled.value.data;
    console.error('⚠️ EA fetch error:', settled.reason?.toString?.() || settled.reason);
    return null;
  }

  const infoRaw = safeData(infoRes);
  const overallStatsRaw = safeData(overallRes);
  const playoffAchievementsRaw = safeData(playoffRes);
  const membersCareerRaw = safeData(careerRes);
  const membersSeasonRaw = safeData(seasonRes);
  const leagueMatchesRaw = safeData(leagueRes);
  const playoffMatchesRaw = safeData(playoffMatchesRes);
  const friendlyMatchesRaw = safeData(friendlyRes);

  // Info is often an object keyed by clubId or an array
  let clubInfo = null;
  if (Array.isArray(infoRaw)) {
    clubInfo = infoRaw[0] || null;
  } else if (infoRaw && typeof infoRaw === 'object') {
    clubInfo = infoRaw[clubIdsParam] || infoRaw;
  }

  // Build compact payloads for OpenAI (but keep data rich)
  const infoPayload = {
    clubInfo,
    leaderboardSeed // includes wins/losses/goals etc from search
  };

  const statsPayload = {
    overallStats: overallStatsRaw,
    playoffAchievements: playoffAchievementsRaw,
    membersCareer: membersCareerRaw,
    membersSeason: membersSeasonRaw
  };

  const matchesPayload = {
    leagueMatches: leagueMatchesRaw,
    playoffMatches: playoffMatchesRaw,
    friendlyMatches: friendlyMatchesRaw
  };

  return {
    infoPayload,
    statsPayload,
    matchesPayload
  };
}

/* -------------------- OPENAI SCOUTING HELPER -------------------- */

async function createScoutingReportFromId(fcPlatform, clubId, displayName, leaderboardSeed) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const { infoPayload, statsPayload, matchesPayload } = await fetchClubData(
    fcPlatform,
    clubId,
    leaderboardSeed
  );

  // Stringify with reasonable limits to avoid context explosion
  const infoStr = JSON.stringify(infoPayload, null, 2);
  const statsStr = JSON.stringify(statsPayload, null, 2);
  const matchesStr = JSON.stringify(matchesPayload, null, 2);

  const inputText = buildUserPrompt({
    displayName,
    clubId,
    fcPlatform,
    infoStr,
    statsStr,
    matchesStr
  });

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: inputText
      }
    ]
  });

  const report = response.output_text || 'No report text returned.';
  return { info: infoPayload.clubInfo || null, report };
}

/* -------------------- READY & COMMAND REGISTRATION -------------------- */

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

/* -------------------- INTERACTION HANDLER -------------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === 'scoutclub') {
        const clubName = interaction.options.getString('name', true);

        await interaction.deferReply();

        const matches = await searchClubsByName(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on EA FC servers. Try a different spelling or the exact in-game name.'
          );
          return;
        }

        // If only one result, go straight to the report
        if (matches.length === 1) {
          const chosen = matches[0];
          const labelPlatform =
            PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

          await interaction.editReply(
            `Found one match: **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId}). Generating scouting report…`
          );

          try {
            const { info, report } = await createScoutingReportFromId(
              chosen.fcPlatform,
              chosen.clubId,
              chosen.name,
              chosen.raw
            );

            const titleName = info?.name || chosen.name;
            const text = report || 'No report generated.';
            const trimmed =
              text.length > 4000 ? text.slice(
