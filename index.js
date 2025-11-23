const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ApplicationCommandOptionType,
  ActionRowBuilder,
  StringSelectMenuBuilder
} = require('discord.js');

const OpenAI = require('openai');

// EA Pro Clubs API wrapper
const clubApi = require('proclubs-api/dist/core/club');
const {
  getClubSearch,
  getClubInfo,
  getClubStats,
  getClubMatchHistory
} = clubApi;

// If getClubSearch is missing in the installed version, this will be undefined
const HAS_SEARCH = typeof getClubSearch === 'function';

// -------------------- ENV VARS --------------------

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN env var not set');
  process.exit(1);
}

const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.warn('⚠️ OPENAI_API_KEY not set – /scoutclub will not work.');
}
const openai = new OpenAI({ apiKey: openaiApiKey });

// Platforms we’ll search across
const PLATFORMS = ['xboxone', 'xbox-series-xs', 'ps5', 'ps4', 'pc'];

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- HELPERS --------------------

// Simple fuzzy score: higher = better match
function scoreNameMatch(query, name) {
  const q = query.toLowerCase();
  const n = name.toLowerCase();

  let score = 0;
  if (n === q) score += 100;          // exact match
  if (n.includes(q)) score += 50;     // substring
  // small penalty for length difference
  score -= Math.abs(n.length - q.length);
  return score;
}

// Search all platforms once and return up to 5 best matches
// => [{ platform, clubId, name }]
async function searchClubsAllPlatforms(query) {
  if (!HAS_SEARCH) {
    console.warn('⚠️ getClubSearch is not available in proclubs-api. Fuzzy search disabled.');
    return [];
  }

  const matchesMap = new Map(); // key: platform:clubId

  for (const platform of PLATFORMS) {
    try {
      console.log(`🔎 getClubSearch("${query}") on ${platform}`);
      const results = await getClubSearch(platform, query);
      if (!Array.isArray(results)) continue;

      for (const club of results) {
        const clubId = String(club.clubId || club.clubid || club.id || '').trim();
        const name = String(
          club.name || club.clubName || club.clubname || ''
        ).trim();

        if (!clubId || !name) continue;

        const key = `${platform}:${clubId}`;
        const s = scoreNameMatch(query, name);

        const existing = matchesMap.get(key);
        if (!existing || s > existing.score) {
          matchesMap.set(key, {
            platform,
            clubId,
            name,
            score: s
          });
        }
      }
    } catch (err) {
      console.error(
        `⚠️ getClubSearch failed for platform=${platform}, query="${query}":`,
        err.message || err
      );
    }
  }

  const matches = Array.from(matchesMap.values());
  if (!matches.length) return [];

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5);
}

// Build scouting report via OpenAI when we ALREADY know platform + clubId
async function createScoutingReportFromKnownClub(platform, clubId, clubName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  console.log(
    `📊 Creating scouting report for ${clubName} (id=${clubId}) on ${platform}`
  );

  const [info, stats, divMatches, cupMatches] = await Promise.all([
    getClubInfo(platform, clubId),
    getClubStats(platform, clubId),
    getClubMatchHistory(platform, clubId, 'matchType9'), // league/division
    getClubMatchHistory(platform, clubId, 'matchType13') // cup
  ]);

  const recentDiv = Array.isArray(divMatches) ? divMatches.slice(0, 20) : [];
  const recentCup = Array.isArray(cupMatches) ? recentCup.slice(0, 10) : [];

  const inputText =
    `You are an experienced EA FC Pro Clubs tactical analyst. ` +
    `Given raw JSON stats and match history, write a concise scouting report for a competitive team.\n\n` +
    `Focus on:\n` +
    `- Overall quality & record\n` +
    `- Formation and playstyle tendencies (possession, direct, wide/narrow, press/drop off)\n` +
    `- Key players and main threats (goals/assists, ratings, positions)\n` +
    `- Defensive tendencies & weaknesses (goals conceded patterns, clean sheets, discipline)\n` +
    `- Suggested game plan to beat them.\n\n` +
    `Club name: ${clubName}\n` +
    `Detected platform: ${platform}\n` +
    `Club ID: ${clubId}\n\n` +
    `Club info JSON:\n${JSON.stringify(info)}\n\n` +
    `Club stats JSON:\n${JSON.stringify(stats)}\n\n` +
    `Recent division matches JSON (up to 20):\n${JSON.stringify(recentDiv)}\n\n` +
    `Recent cup matches JSON (up to 10):\n${JSON.stringify(recentCup)}\n\n` +
    `If some fields are missing or unclear, say that and base your analysis on what you do have.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content:
          'You are an EA FC Pro Clubs opposition scout. Always be clear, concise, and practical.'
      },
      {
        role: 'user',
        content: inputText
      }
    ]
  });

  const report = response.output_text || 'No report text returned.';

  return { platform, clubId, info, report };
}

// -------------------- READY & COMMAND REGISTRATION --------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`✅ App ID: ${c.application.id}`);

  await c.application.commands.set([
    {
      name: 'scoutclub',
      description:
        'Search all platforms for an EA FC Pro Clubs team and get a stats-based report.',
      options: [
        {
          name: 'name',
          description:
            'Approximate club name (you’ll choose from the closest matches)',
          type: ApplicationCommandOptionType.String,
          required: true
        }
      ]
    }
  ]);

  console.log('✅ Commands registered: /scoutclub');
});

// -------------------- INTERACTION HANDLER --------------------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---------- Slash command ----------
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === 'scoutclub') {
        const query = interaction.options.getString('name').trim();

        if (!query) {
          return interaction.reply({
            content: 'Please enter a club name.',
            ephemeral: true
          });
        }

        await interaction.deferReply();

        // 1) Search all platforms ONCE for closest matches
        let matches = [];
        try {
          matches = await searchClubsAllPlatforms(query);
        } catch (err) {
          console.error('❌ Error searching clubs:', err);
        }

        // If we have no fuzzy search capability or no matches, bail
        if (!HAS_SEARCH || matches.length === 0) {
          await interaction.editReply({
            content:
              'I could not find any clubs matching that name on EA servers. Try a different spelling or check the exact in-game name.'
          });
          return;
        }

        // If exactly one match, skip menu and go straight to report
        if (matches.length === 1) {
          const m = matches[0];
          try {
            const { platform, info, report } =
              await createScoutingReportFromKnownClub(
                m.platform,
                m.clubId,
                m.name
              );

            const titleName = info?.name || m.name;
            const text = report || 'No report generated.';
            const trimmed =
              text.length > 4000 ? text.slice(0, 4000) + '…' : text;

            const embed = new EmbedBuilder()
              .setTitle(
                `Scouting report: ${titleName} (${platform.toUpperCase()})`
              )
              .setDescription(trimmed);

            await interaction.editReply({ embeds: [embed], content: null });
          } catch (err) {
            console.error('❌ Error creating report for single match:', err);
            await interaction.editReply({
              content:
                'Found one club, but could not generate the scouting report (API error).'
            });
          }
          return;
        }

        // 2) Multiple matches → show up to 5 as a dropdown
        const options = matches.map((m) => ({
          label: `${m.name} (${m.platform})`,
          value: `${m.platform}:${m.clubId}:${encodeURIComponent(m.name)}`
        }));

        const select = new StringSelectMenuBuilder()
          .setCustomId('scoutclub_pick')
          .setPlaceholder('Choose the correct club')
          .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);

        await interaction.editReply({
          content: `I found these clubs matching **"${query}"**. Pick the correct one to generate a scouting report:`,
          components: [row]
        });

        return;
      }
    }

    // ---------- Select menu: user picked which club to scout ----------
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'scoutclub_pick') {
        const value = interaction.values[0];
        const parts = value.split(':');

        if (parts.length < 3) {
          return interaction.reply({
            content: 'Invalid selection payload.',
            ephemeral: true
          });
        }

        const platform = parts[0];
        const clubId = parts[1];
        const encodedName = parts.slice(2).join(':'); // in case name had ':'
        const clubName = decodeURIComponent(encodedName);

        await interaction.deferUpdate(); // acknowledge the menu click

        try {
          const { info, report } = await createScoutingReportFromKnownClub(
            platform,
            clubId,
            clubName
          );

          const titleName = info?.name || clubName;
          const text = report || 'No report generated.';
          const trimmed =
            text.length > 4000 ? text.slice(0, 4000) + '…' : text;

          const embed = new EmbedBuilder()
            .setTitle(
              `Scouting report: ${titleName} (${platform.toUpperCase()})`
            )
            .setDescription(trimmed);

          await interaction.editReply({
            content: null,
            embeds: [embed],
            components: []
          });
        } catch (err) {
          console.error('❌ Error creating report from selection:', err);
          await interaction.editReply({
            content:
              'I found the club, but generating the scouting report failed (API error).',
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
