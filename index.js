// Enhanced proclubstats.com team page parser for ScoutBot
// Drop this into your index.js, replacing the existing parseProclubsTeamPage()
// implementation. It extracts extra summary data (division, skill rating,
// stadium, recent form, current season & overall PL/W/D/L/GF/GA/GD/Pts) and
// exposes it under both top-level fields and raw.meta so it flows into the
// OpenAI scouting context.

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
