

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

const PLATFORM_LABELS = {
  'common-gen5': 'Cross-gen (Gen5)',
  'common-gen4': 'Cross-gen (Gen4)',
  ps5: 'PlayStation 5',
  ps4: 'PlayStation 4',
  'xbox-series-xs': 'Xbox Series X|S',
  xboxone: 'Xbox One',
  pc: 'PC'
};

// Headers to talk directly to EA's Pro Clubs API
const EA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  accept: 'application/json',
  DNT: '1',
  origin: 'https://www.ea.com',
  referer: 'https://www.ea.com/',
  'sec-ch-ua-platform': '"Windows"'
};

// Headers for scraping proclubstats.com HTML
const PROCLUBS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  DNT: '1',
  referer: 'https://proclubstats.com/',
  origin: 'https://proclubstats.com'
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
   - Friendly matches (often used for scrims and tournaments; treat these as **very important** for understanding tendencies, roughly on par with league matches)

When reasoning:
- Use overall stats for **big-picture quality** and long-term strengths/weaknesses.
- Use match history for **recent form** and **patterns** (e.g., always concede late, win big, high-scoring games, etc.) *only if the data clearly supports it*.
- Use friendly matches heavily for style & patterns, especially since many tournaments are played as friendlies.
- Use player stats to identify **key attackers**, **playmakers**, and **defensive anchors**. Only call someone a “key player” if their stats clearly stand out (more games, more goals/assists, higher ratings, etc.).

### Derived metrics & deeper analysis

Whenever the fields exist, derive **concrete metrics** instead of just restating raw numbers. For example:
- Overall & mode-specific metrics:
  - Win rate, draw rate, loss rate for league / playoffs / friendlies.
  - Goals scored per game and conceded per game (GF/GP, GA/GP) by mode.
  - Average goal difference per game and how often matches are decided by 1 goal vs 2+ goals.
- Attacking efficiency:
  - Share of total goals contributed by top 1–3 scorers (how dependent they are on certain players).
  - Goals + assists per game or per 90 minutes for key players (if minutes or games exist).
  - If shots/expected goals exist, comment on conversion (clinical vs wasteful) without inventing concrete numbers.
- Defensive profile:
  - Clean-sheet rate, frequency of conceding 2+ goals.
  - If card/foul data exists, comment on aggression vs discipline.
- Mode comparison:
  - Compare league vs playoff vs friendly performance (e.g., better in friendlies than league, or vice versa).
  - Highlight if friendlies suggest a more attacking / open style than league.

Only compute metrics that are clearly supported by the available fields. When the data is thin, say so instead of stretching it.

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
   - Include 1–3 headline metrics (overall win rate, GF/GA per game, or similar) if you can.

2. **Attacking Tendencies**
   - How often they score.
   - Whether they seem direct vs possession-based (if shot counts, pass counts, or relevant stats exist).
   - Preferred threats: through the middle vs wide, headers vs long shots, etc. (only if supported).

3. **Defensive Tendencies**
   - Goals conceded, clean sheet rate.
   - Patterns: concede early/late, vulnerable to counters, weak defending crosses, etc. (only if supported).
   - Discipline if cards/fouls are present.

4. **Key Players & Roles**
   - 3–6 standout players, with:
     - Their apparent position or role (inferred from stats or any position fields).
     - Why they are important (goals, assists, games played, rating, etc.).
   - Highlight how concentrated their goal creation is (e.g. top 2 players responsible for most goals) when supported.
   - Do not list every player. Focus on the clearest standouts.

5. **Recent Form & Mentality**
   - Use the most recent slice of league/playoff/friendly matches provided.
   - Win/loss tendencies, blowouts vs tight games, comebacks/choking if the data supports it.
   - If there is a big contrast between friendlies and league/playoffs, call that out.

6. **Game Plan to Beat Them**
   - Make this section **as specific and concrete as possible**, but only when the data clearly supports it.
   - Tie every recommendation to observed patterns, for example:
     - If they concede many goals from crosses or headers, suggest overloading wide areas and attacking the back post.
     - If they score many counterattack goals with a specific striker, suggest a deeper line or dedicated cover.
     - If they struggle in close games or concede late, suggest sustained pressure late in each half.
     - If their friendlies show a very different style from league games, prioritize what you see in **friendlies plus playoffs** for tournament prep.
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
- Before you start writing, scan these blobs and mentally compute as many **summary and per-game metrics** as you can (win rate, goals for/against per match, contribution of top scorers, clean-sheet rate, etc.) wherever the data allows.
- Only talk about players, stats, and patterns that you can reasonably derive from these JSON structures.
- If any of the JSON is clearly partial or truncated, treat that section as partial data.
- If something important (like positions, cards, or timestamps) is missing, acknowledge that briefly instead of guessing.

Now, using ONLY this data, write the scouting report as described in the system message. Do not restate the raw JSON; just output the final report with the requested headings and football analysis.`;
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

/* -------------------- PROCLUBSTATS SCRAPING HELPERS -------------------- */

// Reproduce the slugify() logic used by proclubstats.com team pages.
function slugifyProclubsName(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '_') // spaces -> underscores
    .replace(/[^\w\-]+/g, '') // strip non word chars
    .replace(/_+/g, '_') // collapse multiple underscores
    .replace(/^_+|_+$/g, ''); // trim leading/trailing underscores
}

// Enhanced proclubstats.com team page parser for ScoutBot
// Replaces the older parseProclubsTeamPage() implementation. It extracts extra
// summary data (division, skill rating, stadium, recent form, current season &
// overall PL/W/D/L/GF/GA/GD/Pts) and exposes it under both top-level fields and
// raw.meta so it flows into the OpenAI scouting context.
function parseProclubsTeamPage(html, queryName, fallbackPlatform, sourceUrl) {
  if (typeof html !== 'string') return null;

  const slugTarget = slugifyProclubsName(queryName);

  // First, locate the best clubId/name match from the PHP-style details array.
  const detailsRegex =
    /\["name"\]\s*=>\s*(?:string\(\d+\)\s*)?"([^"]+)"[\s\S]{0,300}?\["clubId"\]\s*=>\s*(?:string\(\d+\)\s*)?(?:int\()?([0-9]+)\)?/g;

  let best = null;
  let match;
  while ((match = detailsRegex.exec(html)) !== null) {
    const name = match[1];
    const clubId = match[2];
    const slug = slugifyProclubsName(name);
    if (slug === slugTarget) {
      best = { name, clubId };
      break;
    }
    if (!best && slug && slug.includes(slugTarget)) {
      best = { name, clubId };
    }
  }

  // If we didn't find any matching details block, fall back to first clubId in page
  if (!best) {
    const fallbackIdMatch = html.match(
      /\["clubId"\]\s*=>\s*(?:string\(\d+\)\s*)?(?:int\()?([0-9]+)\)?/
    );
    if (!fallbackIdMatch) {
      return null;
    }
    best = { name: queryName, clubId: fallbackIdMatch[1] };
  }

  const teamNameMatch = html.match(/var\s+teamName\s*=\s*"([^"]+)"/i);
  const platformMatch = html.match(/var\s+platform\s*=\s*"([^"]+)"/i);

  const platform =
    platformMatch && platformMatch[1]
      ? platformMatch[1]
      : fallbackPlatform || 'common-gen5';

  const teamNameVar =
    teamNameMatch && teamNameMatch[1] ? teamNameMatch[1] : best.name;

  // --- Extra parsing: division, skill rating, stadium, recent form, season / overall stats ---

  function toInt(str) {
    if (typeof str !== 'string') return null;
    const cleaned = str.replace(/,/g, '').trim();
    const n = parseInt(cleaned, 10);
    return Number.isNaN(n) ? null : n;
  }

  const divisionMatch = html.match(
    /divisioncrest[^"]*"\s+title="([^"]+)"/i
  );
  const currentDivision = divisionMatch ? divisionMatch[1].trim() : null;

  const skillMatch = html.match(
    /Skill Rating<\/div>\s*<div[^>]*>\s*([^<\n]+?)\s*<\/div>/i
  );
  const skillRating = skillMatch ? skillMatch[1].trim() : null;

  const stadiumMatch = html.match(
    /data-lucide="map-pin"[^>]*><\/i>\s*([^<]+)/i
  );
  const stadiumName = stadiumMatch ? stadiumMatch[1].trim() : null;

  // Recent (Last 5 Matches) summary block
  let recentForm = null;
  const recentBlock = html.match(
    /Recent\s*\(Last 5 Matches\)[\s\S]{0,800}?Last 5 Games<\/span>\s*<span[^>]*>([^<]+)<\/span>[\s\S]{0,400}?GD<\/span>\s*<span[^>]*>([^<]+)<\/span>[\s\S]{0,400}?Form<\/span>\s*<span[^>]*>([^<]+)<\/span>/i
  );
  if (recentBlock) {
    const last5Str = recentBlock[1].trim();
    const gdStr = recentBlock[2].trim();
    const formStr = recentBlock[3].trim();

    let wins5 = null;
    let draws5 = null;
    let losses5 = null;
    const wdl = last5Str.match(/W(\d+)\s*D(\d+)\s*L(\d+)/i);
    if (wdl) {
      wins5 = parseInt(wdl[1], 10);
      draws5 = parseInt(wdl[2], 10);
      losses5 = parseInt(wdl[3], 10);
    }

    const gdNum = parseInt(gdStr.replace(/[^\d\-+]/g, ''), 10);
    recentForm = {
      label: formStr,
      last5Text: last5Str,
      last5: {
        wins: wins5,
        draws: draws5,
        losses: losses5
      },
      goalDiff: Number.isNaN(gdNum) ? null : gdNum
    };
  }

  // Helper to parse the PL/W/D/L/GF/GA/GD/Pts grid for a given section heading
  function extractGridSection(headingText) {
    const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const gridRegex = new RegExp(
      escaped +
        '[\\s\\S]{0,800}?<div>PL<\\/div><div>W<\\/div><div>D<\\/div><div>L<\\/div>[\\s\\S]{0,800}?<div>([0-9,.]+)<\\/div>\\s*<div>([0-9,.]+)<\\/div>\\s*<div>([0-9,.]+)<\\/div>\\s*<div>([0-9,.]+)<\\/div>\\s*<div>([0-9,.]+)<\\/div>\\s*<div>([0-9,.]+)<\\/div>[\\s\\S]{0,800}?<div[^>]*>([+\\-0-9,]+)<\\/div>[\\s\\S]{0,800}?<div[^>]*>([0-9,.]+)<\\/div>',
      'i'
    );
    const m = html.match(gridRegex);
    if (!m) return null;

    const [
      ,
      pl,
      w,
      d,
      l,
      gf,
      ga,
      gd,
      pts
    ] = m;

    return {
      played: toInt(pl),
      wins: toInt(w),
      draws: toInt(d),
            losses: toInt(l),
      goalsFor: toInt(gf),
      goalsAgainst: toInt(ga),
      goalDiff: toInt(gd),
      points: toInt(pts)
    };
  }

  const currentSeason = extractGridSection('Current Season');
  const overallStats = extractGridSection('Overall Stats');

  const primaryStats = overallStats || currentSeason || null;

  const gamesPlayed = primaryStats ? primaryStats.played : null;
  const wins = primaryStats ? primaryStats.wins : null;
  const draws = primaryStats ? primaryStats.draws : null;
  const losses = primaryStats ? primaryStats.losses : null;
  const goalsFor = primaryStats ? primaryStats.goalsFor : null;
  const goalsAgainst = primaryStats ? primaryStats.goalsAgainst : null;

  return {
    fcPlatform: platform,
    clubId: String(best.clubId),
    name: teamNameVar || best.name,
    division: currentDivision,
    currentDivision,
    skillRating,
    stadiumName,
    recentForm,
    currentSeason,
    overallStats,
    wins,
    losses,
    ties: draws,
    gamesPlayed,
    goals: goalsFor,
    goalsAgainst,
    raw: {
      source: 'proclubstats',
      url: sourceUrl,
      meta: {
        division: currentDivision,
        skillRating,
        stadiumName,
        recentForm,
        currentSeason,
        overallStats,
        summary: {
          gamesPlayed,
          wins,
          draws,
          losses,
          goalsFor,
          goalsAgainst
        }
      }
    }
  };
}

// Search for clubs by name using proclubstats.com instead of EA leaderboard
async function searchClubsByName(query) {
  const q = (query || '').trim();
  if (!q) return [];

  const slug = slugifyProclubsName(q);

  // Try likely platforms – proclubstats uses `platform` query param
  const platformsToTry = [
    'common-gen5',
    'ps5',
    'xbox-series-xs',
    'pc',
    'common-gen4',
    'ps4',
    'xboxone'
  ];

  const results = [];

  await Promise.all(
    platformsToTry.map(async (platform) => {
      const url = `https://proclubstats.com/team/${encodeURIComponent(
        slug
      )}?platform=${encodeURIComponent(platform)}`;

      try {
        const res = await axios.get(url, {
          headers: PROCLUBS_HEADERS,
          timeout: 8000,
          validateStatus: () => true
        });

        if (res.status !== 200) {
          // 404 etc are normal when a club doesn't exist for that platform
          console.warn(
            `⚠️ proclubstats search: HTTP ${res.status} for ${url}`
          );
          return;
        }

        const parsed = parseProclubsTeamPage(
          res.data,
          q,
          platform,
          url
        );
        if (parsed) {
          results.push(parsed);
        }
      } catch (err) {
        console.error(
          `⚠️ Error scraping proclubstats for platform=${platform}, query="${q}":`,
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
    membersSeason: axios.get(
      'https://proclubs.ea.com/api/fc/members/stats',
      {
        params: singleClubParams,
        headers: EA_HEADERS,
        timeout: 8000
      }
    ),
    leagueMatches: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/matches',
      {
        params: {
          ...clubParams,
          matchType: 'leagueMatch',
          maxResultCount: 50
        },
        headers: EA_HEADERS,
        timeout: 10000
      }
    ),
    playoffMatches: axios.get(
      'https://proclubs.ea.com/api/fc/clubs/matches',
      {
        params: {
          ...clubParams,
          matchType: 'playoffMatch',
          maxResultCount: 50
        },
        headers: EA_HEADERS,
        timeout: 10000
      }
    ),
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
    leaderboardSeed // includes URL + source from proclubstats
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

/* -------------------- MATCH SUMMARY HELPERS (LAST 50) -------------------- */

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
  const playoffs =
    computeRecord(matchesPayload.playoffMatches, clubId) || empty;
  const friendlies =
    computeRecord(matchesPayload.friendlyMatches, clubId) || empty;

  function formatLine(label, rec) {
    if (!rec.played) return `${label}: no matches in last 50.`;
    const { played, wins, draws, losses, goalsFor, goalsAgainst, goalDiff } =
      rec;
    return `${label}: ${wins}-${draws}-${losses} in ${played} matches, GF ${goalsFor} / GA ${goalsAgainst} (GD ${
      goalDiff >= 0 ? '+' : ''
    }${goalDiff})`;
  }

  const lines = [
    `Last 50 matches for **${displayName}** (by mode):`,
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

  // Stringify with limits to avoid context explosion
  const infoStr = safeJsonStringify(infoPayload, 8000);
  const statsStr = safeJsonStringify(statsPayload, 24000);
  const matchesStr = safeJsonStringify(matchesPayload, 24000);

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
        'Show a summary of the last 50 league/playoff/friendly matches for a club.',
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

        const matches = await searchClubsByName(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on proclubstats.com. Try a different spelling or the exact in-game name.'
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

        // Multiple results: let user choose via dropdown (in practice, proclubstats will usually give at most 1 per platform)
        const top = matches.slice(0, 5);
        pendingScoutChoices.set(interaction.user.id, {
          query: clubName,
          results: top
        });

        const options = top.map((club, index) => {
          const labelPlatform =
            PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;

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
            PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;
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

        const matches = await searchClubsByName(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on proclubstats.com. Try a different spelling or the exact in-game name.'
          );
          return;
        }

        // If only one result, go straight to the summary
        if (matches.length === 1) {
          const chosen = matches[0];
          const labelPlatform =
            PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

          await interaction.editReply(
            `Found one match: **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId}). Fetching last 50 matches…`
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
            console.error('❌ Error summarizing last 50 matches:', err);
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
            PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;

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
            PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;
          const parts = [labelPlatform];
          const extra = parts.length ? ' – ' + parts.join(' / ') : '';
          return `**${index + 1}.** ${club.name}${extra}`;
        });

        const embed = new EmbedBuilder()
          .setTitle('Multiple clubs found')
          .setDescription(
            lines.join('\n') +
              '\n\nUse the dropdown below to pick the club whose last 50 matches you want to see.'
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
          PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

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

      // User picks which club's last 50 matches to show
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
          PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

        await interaction.deferUpdate();

        await interaction.editReply({
          content: `Fetching last 50 matches for **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId})…`,
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
          console.error('❌ Error summarizing last 50 matches (select):', err);

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
      await interaction.reply({
        content: 'Error.',
        ephemeral: true
      });
    }
  }
});

/* -------------------- LOGIN -------------------- */

client.login(token);
