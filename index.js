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

// FC “platform” values, not xboxone/ps5/etc – these are what the FC endpoints expect
const FC_PLATFORMS = ['common-gen5', 'common-gen4'];

const FC_PLATFORM_LABELS = {
  'common-gen5': 'Gen 5 (PS5 / Xbox Series / PC)',
  'common-gen4': 'Gen 4 (PS4 / Xbox One)'
};

// Store pending choices per user for the select menu
// Map<userId, { query: string, results: Array<{ fcPlatform, clubId, name, region, division }> }>
const pendingScoutChoices = new Map();

// Common headers copied from your curls so Akamai doesn’t block us
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

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- EA FC HELPERS --------------------

// 1) Search clubs by name using FC allTimeLeaderboard
async function searchClubsAcrossPlatforms(query) {
  const results = [];
  const q = query.trim();
  if (!q) return results;

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
            timeout: 8000
          }
        );

        // You may want to log this once to inspect:
        // console.dir(res.data, { depth: null });

        const clubs =
          res.data?.entries ||
          res.data?.clubs ||
          res.data?.result ||
          [];

        if (Array.isArray(clubs)) {
          for (const club of clubs) {
            if (!club) continue;

            const clubId =
              String(
                club.clubId ??
                  club.clubID ??
                  club.club
              ) || null;
            if (!clubId) continue;

            results.push({
              fcPlatform,
              clubId,
              name: club.name || club.clubName || q,
              region:
                club.regionName ||
                club.region ||
                club.countryName ||
                null,
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

// 2) FC clubs info – your curl: /api/fc/clubs/info?platform=common-gen5&clubIds=104358
async function fetchFcClubInfo(fcPlatform, clubId) {
  const platformParam =
    fcPlatform === 'common-gen4' ? 'common-gen4' : 'common-gen5';

  try {
    const res = await axios.get(
      'https://proclubs.ea.com/api/fc/clubs/info',
      {
        params: {
          platform: platformParam,
          clubIds: String(clubId)
        },
        headers: FC_HEADERS,
        timeout: 8000
      }
    );

    // Usually this endpoint returns an object keyed by clubId or an array – handle both
    const data = res.data;
    if (!data) return null;

    if (Array.isArray(data)) {
      return data[0] || null;
    }

    if (typeof data === 'object') {
      // Often it’s { "<id>": { ...clubInfo } }
      const firstKey = Object.keys(data)[0];
      return data[firstKey] || null;
    }

    return null;
  } catch (err) {
    console.error(
      `⚠️ FC club info error for clubId=${clubId}, platform=${platformParam}:`,
      err.toString()
    );
    return null;
  }
}

// 3) FC members stats – your curl: /api/fc/members/stats?platform=common-gen5&clubId=104358
async function fetchFcMemberStats(fcPlatform, clubId) {
  const platformParam =
    fcPlatform === 'common-gen4' ? 'common-gen4' : 'common-gen5';

  try {
    const res = await axios.get(
      'https://proclubs.ea.com/api/fc/members/stats',
      {
        params: {
          platform: platformParam,
          clubId: String(clubId)
        },
        headers: FC_HEADERS,
        timeout: 8000
      }
    );

    return res.data || null;
  } catch (err) {
    console.error(
      `⚠️ FC members stats error for clubId=${clubId}, platform=${platformParam}:`,
      err.toString()
    );
    return null;
  }
}

// (optional) FC career stats – if you still want /members/career/stats
async function fetchFcCareerStats(fcPlatform, clubId) {
  const platformParam =
    fcPlatform === 'common-gen4' ? 'common-gen4' : 'common-gen5';

  try {
    const res = await axios.get(
      'https://proclubs.ea.com/api/fc/members/career/stats',
      {
        params: {
          platform: platformParam,
          clubId: String(clubId)
        },
        headers: FC_HEADERS,
        timeout: 8000
      }
    );

    return res.data || null;
  } catch (err) {
    console.error(
      `⚠️ FC career stats error for clubId=${clubId}, platform=${platformParam}:`,
      err.toString()
    );
    return null;
  }
}

// -------------------- OPENAI SCOUTING HELPER --------------------

async function createScoutingReportFromId(fcPlatform, clubId, displayName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  // Fetch FC info + member stats (+ optional career stats)
  const [clubInfo, memberStats, careerStats] = await Promise.all([
    fetchFcClubInfo(fcPlatform, clubId),
    fetchFcMemberStats(fcPlatform, clubId),
    fetchFcCareerStats(fcPlatform, clubId)
  ]);

  const inputText =
    `You are an experienced EA FC Pro Clubs tactical analyst. ` +
    `Given raw JSON stats and club info, write a concise scouting report for a competitive team.\n\n` +
    `Focus on:\n` +
    `- Overall quality & record\n` +
    `- Formation and playstyle tendencies (possession, direct, wide/narrow, press/drop off)\n` +
    `- Key players and main threats (goals/assists, ratings, positions)\n` +
    `- Defensive tendencies & weaknesses (goals conceded patterns, clean sheets, discipline)\n` +
    `- Suggested game plan to beat them.\n\n` +
    `Club display name (from search): ${displayName}\n` +
    `EA internal club ID: ${clubId}\n` +
    `FC platform: ${fcPlatform}\n\n` +
    `FC club info JSON (/fc/clubs/info):\n${JSON.stringify(
      clubInfo
    )}\n\n` +
    `FC member stats JSON (/fc/members/stats):\n${JSON.stringify(
      memberStats
    )}\n\n` +
    `FC career stats JSON (/fc/members/career/stats):\n${JSON.stringify(
      careerStats
    )}\n\n` +
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
  return { clubInfo, report };
}

// -------------------- READY & COMMAND REGISTRATION --------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`✅ App ID: ${c.application.id}`);

  // Global command so it works on every server the bot is in
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

      // /scoutclub – search all FC platforms, choose club, generate report
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
            const { clubInfo, report } = await createScoutingReportFromId(
              chosen.fcPlatform,
              chosen.clubId,
              chosen.name
            );

            const titleName = clubInfo?.name || chosen.name;
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
            FC_PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;
          const labelRegion = club.region ? ` – ${club.region}` : '';
          const labelDivision = club.division ? ` – Div ${club.division}` : '';

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
            FC_PLATFORM_LABELS[club.fcPlatform] || club.fcPlatform;
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
          FC_PLATFORM_LABELS[chosen.fcPlatform] || chosen.fcPlatform;

        // Acknowledge quickly, then do the heavy work
        await interaction.deferUpdate();

        // Update the original message to show that we're working
        await interaction.editReply({
          content: `Generating scouting report for **${chosen.name}** on **${labelPlatform}** (club ID: ${chosen.clubId})…`,
          embeds: [],
          components: []
        });

        try {
          const { clubInfo, report } = await createScoutingReportFromId(
            chosen.fcPlatform,
            chosen.clubId,
            chosen.name
          );

          const titleName = clubInfo?.name || chosen.name;
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
