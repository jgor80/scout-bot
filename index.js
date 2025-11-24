// Hit FC "allTimeLeaderboard" search and collect matching clubs
async function searchClubsAcrossPlatforms(query) {
  const results = [];
  const q = query.trim();
  if (!q) return results;

  await Promise.all(
    FC_SEARCH_PLATFORMS.map(async (fcPlatform) => {
      try {
        const res = await axios.get(
          'https://proclubs.ea.com/api/fc/allTimeLeaderboard/search',
          {
            params: {
              platform: fcPlatform,
              clubName: q
            },
            headers: {
              accept: 'application/json',
              'accept-language': 'en-US,en;q=0.9',
              'content-type': 'application/json',
              dnt: '1',
              origin: 'https://www.ea.com',
              referer: 'https://www.ea.com/',
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
            },
            timeout: 8000
          }
        );

        // You’ll want to tweak this once you see the exact JSON.
        // Common patterns from FC APIs:
        const clubs =
          res.data?.entries || res.data?.clubs || res.data?.result || [];

        if (Array.isArray(clubs)) {
          for (const club of clubs) {
            if (!club) continue;

            const clubId =
              String(club.clubId ?? club.clubID ?? club.club) || null;
            if (!clubId) continue;

            results.push({
              fcPlatform, // common-gen5 / common-gen4
              clubId,
              name: club.name || club.clubName || q,
              region:
                club.regionName || club.region || club.countryName || null,
              division: club.division || club.leagueDivision || null
            });
          }
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

  return unique;
}
