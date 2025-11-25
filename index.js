// index.js – ScoutBot (FC Pro Clubs Scouting)
require('dotenv').config();

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

// FC “platform” values, not xboxone/ps5/etc – these are what the FC endpoints expect
const FC_PLATFORMS = ['common-gen5', 'common-gen4'];

const FC_PLATFORM_LABELS = {
  'common-gen5': 'Gen 5 (PS5 / Xbox Series / PC)',
  'common-gen4': 'Gen 4 (PS4 / Xbox One)'
};

// Common headers copied from browser curls so Akamai doesn’t block us
const FC_HEADERS = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  dnt: '1',
  origin: 'https://www.ea.com',
  referer: 'https://www.ea.com/',
  'sec-ch-ua':
    '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
};

// Store pending choices per user for the select menus
// Map<userId, { query: string, results: Array<clubCandidate> }>
const pendingScoutChoices = new Map();
const pendingMatchesChoices = new Map();

/* -------------------- DISCORD CLIENT -------------------- */

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* -------------------- OPENAI PROMPTS -------------------- */

const SYSTEM_PROMPT = `
You are an experienced EA FC Pro Clubs opposition scout.

You will receive:
- Club info JSON for a single team
- Aggregated club + player stats JSON (career + season)
- Match history JSON for league, playoffs, and friendlies (trimmed and sometimes truncated)

Your job: produce a concise, practical scouting report for a competitive Pro Clubs team.

### Absolute priority (what you care about most)

1. **Roster & player statistics**  
   - Who plays the most, who produces the most (G/A), who anchors the defense.  
   - How production is distributed across the squad (top 1–3 vs the rest).  
   - Roles by line: **strikers, wingers, midfielders, full-backs, centre-backs, goalkeeper**.

2. **Formations & positional tendencies**  
   - Which formations show up most in the match JSON (e.g., 4-3-3, 4-2-3-1, 3-5-2), if a formation field exists.  
   - How those shapes map onto lines (back 4 vs back 3, single or double pivot, wide vs narrow front line).

3. **Match outcomes & mode splits**  
   - Overall level (win rate, GF/GA per game, goal difference).  
   - League vs playoff vs friendly performance and how they differ.

### Roster-first analysis

When fields exist, treat the **player / roster JSON as your primary lens**:

- Identify **high-usage players** (most games played or minutes if available).
- Identify **high-impact players** (most goals, assists, G+A per game, highest ratings).
- Try to infer **roles/positions** from any relevant fields, for example:
  - `position`, `preferredPosition`, `pos`, `role`, or similar.
  - Any hints from formation/lineup structures in match JSON.
- Group players by line where possible:
  - **Striker(s)** (central goal scorers)
  - **Wingers / wide forwards**
  - **Attacking / central / defensive midfielders**
  - **Full-backs / wing-backs**
  - **Centre-backs**
  - **Goalkeeper**
- If true positions are not explicit, you may infer **“attacking / midfield / defensive / goalkeeper”** archetypes from stat profiles (e.g. high goals → attacker, high tackles/clearances → defender), but say when it’s an inference.

Whenever feasible, give **number-heavy summaries** like:
- Appearances, goals, assists, G+A per game.
- Share of team goals or G+A contributed by a player or a small core.
- “Top 2–3 attackers contribute ~X% of the team’s goals.”

Focus on **who you must stop or play around**: star striker, chief creator, main CB, standout GK, etc.

### Using match data

Use match history to support and sharpen the roster analysis:

- For each mode where enough matches exist (league / playoff / friendly), derive where possible:
  - **Win / draw / loss counts and rates**
  - **Goals scored per game (GF/GP)** and **goals conceded per game (GA/GP)**
  - **Average goal difference per game**
- If formation info exists in matches, identify the **top 2–3 formations used**, and whether they switch shape between modes.
- Use match-level patterns only when strongly supported:
  - Often win by big margins vs many one-goal games.
  - Frequently concede 2+ goals vs many low-scoring games.
  - Clear contrast between friendlies and league/playoffs (e.g., more open and high-scoring friendlies).

### Derived metrics & deeper analysis

Whenever the fields exist, compute **concrete metrics** instead of just repeating raw numbers:

- **Overall & mode-specific metrics**
  - Win, draw, loss rates.
  - GF/GP, GA/GP, average goal difference.
- **Attacking efficiency**
  - % of goals scored by the top 1–3 scorers.
  - G+A per game for main attackers and creators.
- **Defensive profile**
  - Clean-sheet rate (if clean sheets or 0 GA can be inferred).
  - Frequency of conceding 2+ goals.
  - Cards/fouls → aggressive vs disciplined, if those fields exist.
- **Concentration vs balance**
  - Is the attack heavily dependent on one player?
  - Is chance creation spread across multiple mids/wingers?

Only compute metrics that are clearly supported by the data. If the sample size is small or fields are missing, say so instead of stretching conclusions.

If timestamps, seasons, or ordering fields are present you may comment on trends.  
If not, avoid “early season / late season” talk; just summarize overall patterns from the sample.

### Style & structure

- Address the report to a **coach preparing to play this team**.
- Be **clear, number-heavy, and practical**.
- Do **not** mention JSON, fields, or technical details. Just talk football.
- Avoid filler and hype. Focus on insights.

Organize the report with headings like:

1. **Overall Summary**
   - 2–4 sentences.
   - Include 2–3 headline metrics (e.g. overall W-D-L, GF/GP, GA/GP, goal difference).

2. **Squad Profile & Key Roles**
   - Start with a **roster-level view**: core squad size, reliance on a few heavy-minute players vs rotation.
   - Identify **top players by line** where possible:
     - 1 GK, 2–3 CBs, 2 full-backs, 2–3 mids, 2–3 wingers, 1–2 strikers.
   - For each key player, include a short, number-heavy line (apps, G, A, G+A/game, share of team output, etc.).

3. **Attacking Tendencies**
   - How often they score and concede.
   - Where the danger comes from (central striker, wide players, late-running mids, set pieces) when stats or patterns support it.
   - Any formation-related tendencies (e.g. back 3 with wing-backs vs classic back 4).

4. **Defensive Tendencies**
   - GA/GP, clean-sheet feel, how often they concede multiple goals.
   - Whether they look compact or exposed (e.g. concede many in high-scoring games, or mostly tight games).
   - Discipline if card/foul data exists.

5. **Recent Form & Mentality**
   - Use the most recent slice of matches provided.
   - Tight vs open games, resilience/comebacks vs collapsing when behind (only when clearly supported).
   - Note any contrast between friendlies and league/playoffs.

6. **Game Plan to Beat Them**
   - Make this section **as specific and concrete as the data allows**, always tying recommendations to actual numbers/patterns.
   - Examples:
     - “Attack their full-backs: they concede many goals in wide overloads and crosses.”
     - “Cut service to their main striker who accounts for ~X% of goals.”
     - “Exploit spaces behind aggressive CBs who step out a lot (high GA/GP despite strong scoring).”
   - Avoid generic advice like “just play your game”; every bullet must map to an observed tendency.

7. **Uncertainties & Data Gaps (if needed)**
   - Briefly list anything that limits confidence (missing positions, very small sample size, partial match history, etc.).

Keep the entire report **under ~3500 characters**, but do not hide key numeric insights just to be shorter.
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
- Put the **highest weight** on the **roster and player statistics**: who plays, who produces (G/A), what their roles/positions appear to be.
- Use match history mainly to:
  - Check consistency of those patterns over time.
  - Derive win/draw/loss records and GF/GA per game by mode.
  - Identify commonly used formations if any formation fields are present.
- Before you start writing, scan these blobs and mentally compute as many **summary and per-game metrics** as you can (win rate, GF/GP, GA/GP, goal difference, contribution of top scorers, etc.) wherever the data allows.
- Only talk about players, stats, roles, formations, and patterns that you can reasonably derive from these JSON structures.
- If any of the JSON is clearly partial or truncated, treat that section as partial data and state that briefly.
- If something important (like exact positions, cards, or timestamps) is missing, acknowledge that instead of guessing.

Now, using ONLY this data, write the scouting report as described in the system message. Do not restate the raw JSON; just output the final report with the requested headings, focusing on **numbers, roster structure, and exploitable tendencies**.`;
}

/* -------------------- UTILS -------------------- */

function safeJsonStringify(obj, maxChars) {
  try {
    const s = JSON.stringify(obj);
    if (!maxChars) return s;
    return s.length > maxChars ? s.slice(0, maxChars) : s;
  } catch (e) {
    return String(obj || '').slice(0, maxChars || 8000);
  }
}

function isNonEmpty(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function countMatches(raw) {
  if (!raw) return 0;
  if (Array.isArray(raw)) return raw.length;
  if (Array.isArray(raw.matches)) return raw.matches.length;
  if (typeof raw === 'object') {
    let total = 0;
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) total += v.length;
      else if (v && Array.isArray(v.matches)) total += v.matches.length;
    }
    return total;
  }
  return 0;
}

function countPlayers(raw) {
  if (!raw) return 0;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'object') {
    let total = 0;
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) total += v.length;
    }
    return total || Object.keys(raw).length;
  }
  return 0;
}

/* -------------------- EA SEARCH HELPERS (EA-only) -------------------- */

// EA-only search, similar idea to FC26_API.search_club_by_name
async function searchClubsAcrossPlatforms(query) {
  const q = (query || '').trim();
  if (!q) return [];

  const results = [];

  console.log(
    '[DEBUG] searchClubsAcrossPlatforms: searching "%s" on platforms: %s',
    q,
    FC_PLATFORMS.join(', ')
  );

  await Promise.all(
    FC_PLATFORMS.map(async (fcPlatform) => {
      try {
        const res = await axios.get(
          'https://proclubs.ea.com/api/fc/allTimeLeaderboard/search',
          {
            params: {
              platform: fcPlatform,
              clubName: q
            },
            headers: FC_HEADERS,
            timeout: 10000,
            validateStatus: () => true
          }
        );

        console.log(
          '[DEBUG] leaderboard search platform=%s, status=%s',
          fcPlatform,
          res.status
        );

        if (res.status !== 200 || !res.data) return;

        let data = res.data;

        // Some responses come wrapped keyed at "0", unwrap that if present
        if (data && typeof data === 'object' && data['0']) {
          console.log(
            '[DEBUG] leaderboard payload (platform=%s) keys: %s',
            fcPlatform,
            Object.keys(data)
          );
          data = data['0'];
        } else if (data && typeof data === 'object') {
          console.log(
            '[DEBUG] leaderboard payload (platform=%s) keys: %s',
            fcPlatform,
            Object.keys(data)
          );
        }

        let rows = [];
        if (Array.isArray(data)) {
          rows = data;
        } else if (data && typeof data === 'object') {
          rows = Object.values(data).filter(
            (v) => v && typeof v === 'object'
          );
        }

        console.log(
          '[DEBUG] leaderboard parsed clubs platform=%s: %d',
          fcPlatform,
          rows.length
        );

        for (const row of rows) {
          const info = row.clubInfo || row.clubinfo || row.info || row;
          if (!info || typeof info !== 'object') continue;

          const clubId = String(
            info.clubId ?? info.clubID ?? info.id ?? info.club ?? ''
          );
          if (!clubId) continue;

          const name =
            info.name ||
            info.clubName ||
            info.clubname ||
            q;

          const region =
            info.regionName ||
            info.region ||
            info.countryName ||
            null;

          const division =
            info.division ||
            info.leagueDivision ||
            info.bestDivision ||
            null;

          results.push({
            fcPlatform,
            clubId,
            name,
            region,
            division,
            raw: info // this is the leaderboard/all-time stats row
          });
        }
      } catch (err) {
        console.error(
          `⚠️ FC leaderboard search error for platform=${fcPlatform}, query="${q}":`,
          err.toString()
        );
      }
    })
  );

  // Deduplicate by fcPlatform+clubId
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = `${r.fcPlatform}:${r.clubId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  console.log(
    '[DEBUG] searchClubsAcrossPlatforms: total unique clubs for "%s": %d',
    q,
    unique.length
  );

  return unique;
}

/* -------------------- EA FETCH HELPERS -------------------- */

async function fetchClubData(fcPlatform, clubId, leaderboardSeed = null) {
  const platform = fcPlatform || 'common-gen5';
  const clubIdsParam = String(clubId);

  const baseParams = { platform };
  const clubParams = { ...baseParams, clubIds: clubIdsParam };
  const singleClubParams = { ...baseParams, clubId: clubIdsParam };

  const requests = {
    info: axios.get('https://proclubs.ea.com/api/fc/clubs/info', {
      params: clubParams,
      headers: FC_HEADERS,
      timeout: 8000
    }),
    overallStats: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/overallStats',
      {
        params: clubParams,
        headers: FC_HEADERS,
        timeout: 8000
      }
    ),
    playoffAchievements: axios.get(
      'https://proclubs.ea.com/api/fc/club/playoffAchievements',
      {
        params: singleClubParams,
        headers: FC_HEADERS,
        timeout: 8000
      }
    ),
    membersCareer: axios.get(
      'https://proclubs.ea.com/api/fc/members/career/stats',
      {
        params: singleClubParams,
        headers: FC_HEADERS,
        timeout: 8000
      }
    ),
    membersSeason: axios.get(
      'https://proclubs.ea.com/api/fc/members/stats',
      {
        params: singleClubParams,
        headers: FC_HEADERS,
        timeout: 8000
      }
    ),
    // 🔼 Bumped to 100 to capture more matches per mode
    leagueMatches: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/matches',
      {
        params: {
          ...clubParams,
          matchType: 'leagueMatch',
          maxResultCount: 100
        },
        headers: FC_HEADERS,
        timeout: 10000
      }
    ),
    playoffMatches: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/matches',
      {
        params: {
          ...clubParams,
          matchType: 'playoffMatch',
          maxResultCount: 100
        },
        headers: FC_HEADERS,
        timeout: 10000
      }
    ),
    friendlyMatches: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/matches',
      {
        params: {
          ...clubParams,
          matchType: 'friendlyMatch',
          maxResultCount: 100
        },
        headers: FC_HEADERS,
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
    console.error(
      '⚠️ EA fetch error:',
      settled.reason?.toString?.() || settled.reason
    );
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

  const infoPayload = {
    clubInfo,
    leaderboardSeed // include leaderboard/all-time row alongside info
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

/* -------------------- MATCH SUMMARY HELPERS (LAST 100) -------------------- */

function computeRecord(matches, clubId) {
  if (!Array.isArray(matches)) return null;

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const m of matches) {
    if (!m || !m.clubs || !m.clubs[clubId]) continue;

    const me = m.clubs[clubId];
    const oppId = Object.keys(m.clubs).find((id) => id !== String(clubId));
    const opp = oppId ? m.clubs[oppId] : null;

    const gf = Number(me.goals) || 0;
    const ga = opp ? Number(opp.goals) || 0 : 0;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) wins++;
    else if (gf < ga) losses++;
    else draws++;
  }

  const played = wins + draws + losses;
  const goalDiff = goalsFor - goalsAgainst;

  return { played, wins, draws, losses, goalsFor, goalsAgainst, goalDiff };
}

async function summarizeMatchesForClub(
  fcPlatform,
  clubId,
  displayName,
  leaderboardSeed
) {
  const { matchesPayload } = await fetchClubData(
    fcPlatform,
    clubId,
    leaderboardSeed
  );

  const empty = {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDiff: 0
  };

  const league = computeRecord(matchesPayload.leagueMatches, clubId) || empty;
  const playoffs = computeRecord(matchesPayload.playoffMatches, clubId) || empty;
  const friendlies =
    computeRecord(matchesPayload.friendlyMatches, clubId) || empty;

  function formatLine(label, rec) {
    if (!rec.played) return `${label}: no matches in last sample.`;
    const {
      played,
      wins,
      draws,
      losses,
      goalsFor,
      goalsAgainst,
      goalDiff
    } = rec;
    return `${label}: ${wins}-${draws}-${losses} in ${played} matches, GF ${goalsFor} / GA ${goalsAgainst} (GD ${
      goalDiff >= 0 ? '+' : ''
    }${goalDiff})`;
  }

  const lines = [
    `Last matches for **${displayName}** (by mode, up to EA cap):`,
    formatLine('League', league),
    formatLine('Playoffs', playoffs),
    formatLine('Friendlies', friendlies)
  ];

  return lines.join('\n');
}

/* -------------------- OPENAI SCOUTING HELPER -------------------- */

async function createScoutingReportFromId(
  fcPlatform,
  clubId,
  displayName,
  leaderboardSeed
) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const { infoPayload, statsPayload, matchesPayload } =
    await fetchClubData(fcPlatform, clubId, leaderboardSeed);

  const hasInfo = isNonEmpty(infoPayload?.clubInfo);
  const hasStats = Object.values(statsPayload).some(isNonEmpty);
  const hasMatches = Object.values(matchesPayload).some(isNonEmpty);

  const leagueCount = countMatches(matchesPayload.leagueMatches);
  const playoffCount = countMatches(matchesPayload.playoffMatches);
  const friendlyCount = countMatches(matchesPayload.friendlyMatches);
  const careerPlayers = countPlayers(statsPayload.membersCareer);
  const seasonPlayers = countPlayers(statsPayload.membersSeason);

  console.log('[DEBUG] Data summary for club', clubId, '(', fcPlatform, '):', {
    hasInfo,
    hasStats,
    hasMatches,
    leagueCount,
    playoffCount,
    friendlyCount,
    careerPlayers,
    seasonPlayers
  });

  if (!hasStats && !hasMatches) {
    const err = new Error(
      'No stats or match history available from EA for this club.'
    );
    err.code = 'insufficient_data';
    throw err;
  }

  // 🔼 Widened limits so more raw JSON reaches the model
  const infoStr = safeJsonStringify(infoPayload, 16000);
  const statsStr = safeJsonStringify(statsPayload, 64000);
  const matchesStr = safeJsonStringify(matchesPayload, 64000);

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
    },
    {
      name: 'clubmatches',
      description:
        'Show a summary of the last (up to) 100 league/playoff/friendly matches for a club.',
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

  console.log('✅ Commands registered: /scoutclub, /clubmatches (global)');
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

        const matches = await searchClubsAcrossPlatforms(clubName);

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
            FC_PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

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
              text.length > 4000 ? text.slice(0, 4000) + '…' : text;

            const embed = new EmbedBuilder()
              .setTitle(
                `Scouting report: ${titleName} (${labelPlatform}, ID: ${chosen.clubId})`
              )
              .setDescription(trimmed);

            await interaction.editReply({ content: null, embeds: [embed] });
          } catch (err) {
            console.error('❌ Error creating scouting report from ID:', err);
            if (
              err.code === 'insufficient_quota' ||
              err.error?.code === 'insufficient_quota'
            ) {
              await interaction.editReply(
                'I found the club, but the OpenAI API quota has been exceeded. Please check your billing or try again later.'
              );
            } else if (
              err.code === 'context_length_exceeded' ||
              err.error?.code === 'context_length_exceeded'
            ) {
              await interaction.editReply(
                'I found the club, but the data was too large for the model to process in one go. Try again later or with a different club name.'
              );
            } else if (
              err.code === 'insufficient_data' ||
              err.error?.code === 'insufficient_data'
            ) {
              await interaction.editReply(
                'I found the club, but EA did not return enough stats or match history to generate a meaningful, data-driven scouting report.'
              );
            } else {
              await interaction.editReply(
                'I found the club, but failed to generate a scouting report (EA or OpenAI error).'
              );
            }
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
            FC_PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;

          const description = `${labelPlatform}`.slice(0, 100);

          return {
            label: `${club.name} (${labelPlatform})`,
            description,
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
            FC_PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;
          const parts = [labelPlatform];
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

      if (cmd === 'clubmatches') {
        const clubName = interaction.options.getString('name', true);

        await interaction.deferReply();

        const matches = await searchClubsAcrossPlatforms(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on EA FC servers. Try a different spelling or the exact in-game name.'
          );
          return;
        }

        // If only one result, go straight to the summary
        if (matches.length === 1) {
          const chosen = matches[0];
          const labelPlatform =
            FC_PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

          await interaction.editReply(
            `Found one match: **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId}). Fetching last matches…`
          );

          try {
            const summaryText = await summarizeMatchesForClub(
              chosen.fcPlatform,
              chosen.clubId,
              chosen.name,
              chosen.raw
            );

            await interaction.editReply(summaryText);
          } catch (err) {
            console.error('❌ Error summarizing matches:', err);
            await interaction.editReply(
              'I found the club, but failed to fetch match history from EA.'
            );
          }

          return;
        }

        // Multiple results: let user choose via dropdown
        const top = matches.slice(0, 5);
        pendingMatchesChoices.set(interaction.user.id, {
          query: clubName,
          results: top
        });

        const options = top.map((club, index) => {
          const labelPlatform =
            FC_PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;

          const description = `${labelPlatform}`.slice(0, 100);

          return {
            label: `${club.name} (${labelPlatform})`,
            description,
            value: String(index)
          };
        });

        const select = new StringSelectMenuBuilder()
          .setCustomId('clubmatches_pick')
          .setPlaceholder('Select the correct club')
          .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);

        const lines = top.map((club, index) => {
          const labelPlatform =
            FC_PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;
          const parts = [labelPlatform];
          const extra = parts.length ? ' – ' + parts.join(' / ') : '';
          return `**${index + 1}.** ${club.name}${extra}`;
        });

        const embed = new EmbedBuilder()
          .setTitle('Multiple clubs found')
          .setDescription(
            lines.join('\n') +
              '\n\nUse the dropdown below to pick the club whose recent matches you want to see.'
          );

        await interaction.editReply({
          content: null,
          embeds: [embed],
          components: [row]
        });

        return;
      }
    }

    // Select menus
    if (interaction.isStringSelectMenu()) {
      // User picks which club to scout
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
          FC_PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

        await interaction.deferUpdate();

        await interaction.editReply({
          content: `Generating scouting report for **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId})…`,
          embeds: [],
          components: []
        });

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
            text.length > 4000 ? text.slice(0, 4000) + '…' : text;

          const embed = new EmbedBuilder()
            .setTitle(
              `Scouting report: ${titleName} (${labelPlatform}, ID: ${chosen.clubId})`
            )
            .setDescription(trimmed);

          await interaction.editReply({ content: null, embeds: [embed] });
        } catch (err) {
          console.error('❌ Error creating scouting report (select):', err);

          let msg =
            'I found the club, but failed to generate a scouting report (EA or OpenAI error).';
          if (
            err.code === 'insufficient_quota' ||
            err.error?.code === 'insufficient_quota'
          ) {
            msg =
              'I found the club, but the OpenAI API quota has been exceeded. Please check your billing or try again later.';
          } else if (
            err.code === 'context_length_exceeded' ||
            err.error?.code === 'context_length_exceeded'
          ) {
            msg =
              'I found the club, but the data was too large for the model to process in one go. Try again later or with a different club name.';
          } else if (
            err.code === 'insufficient_data' ||
            err.error?.code === 'insufficient_data'
          ) {
            msg =
              'I found the club, but EA did not return enough stats or match history to generate a meaningful, data-driven scouting report.';
          }

          await interaction.editReply({
            content: msg,
            embeds: [],
            components: []
          });
        }

        return;
      }

      // User picks which club's recent matches to show
      if (interaction.customId === 'clubmatches_pick') {
        const userId = interaction.user.id;
        const state = pendingMatchesChoices.get(userId);

        if (!state) {
          return interaction.reply({
            content:
              'No pending club selection found. Please run `/clubmatches` again.',
            ephemeral: true
          });
        }

        const index = parseInt(interaction.values[0], 10);
        const chosen = state.results[index];
        if (!chosen) {
          return interaction.reply({
            content: 'Invalid club selection. Please run `/clubmatches` again.',
            ephemeral: true
          });
        }

        // Remove pending state so we don't reuse it accidentally
        pendingMatchesChoices.delete(userId);

        const labelPlatform =
          FC_PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

        await interaction.deferUpdate();

        await interaction.editReply({
          content: `Fetching recent matches for **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId})…`,
          embeds: [],
          components: []
        });

        try {
          const summaryText = await summarizeMatchesForClub(
            chosen.fcPlatform,
            chosen.clubId,
            chosen.name,
            chosen.raw
          );

          await interaction.editReply({
            content: summaryText,
            embeds: [],
            components: []
          });
        } catch (err) {
          console.error('❌ Error summarizing matches (select):', err);

          await interaction.editReply({
            content:
              'I found the club, but failed to fetch match history from EA.',
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
      try {
        await interaction.reply({
          content: 'Error.',
          ephemeral: true
        });
      } catch (e) {
        console.error('❌ Failed to send error reply:', e);
      }
    }
  }
});

/* -------------------- LOGIN -------------------- */

client.login(token);
