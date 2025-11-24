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

// For FC 24+, EA is using this aggregated “gen 5” platform on these endpoints
const PLATFORM = 'common-gen5';

// store pending dropdown choices
// Map<userId, { query: string, results: Array<{ clubId, name, region, division }> }>
const pendingScoutChoices = new Map();

// -------------------- EA AXIOS CLIENT --------------------

// Mimic the headers from your working curl examples
const eaClient = axios.create({
  baseURL: 'https://proclubs.ea.com/api/fc',
  timeout: 10000,
  headers: {
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'dnt': '1',
    'origin': 'https://www.ea.com',
    'referer': 'https://www.ea.com/',
    'priority': 'u=1, i',
    'sec-ch-ua':
      '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'content-type': 'application/json'
  }
});

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- EA HELPERS --------------------

/**
 * Try to find clubs by name via FC leaderboard search.
 * Endpoint (structure inferred from your earlier curl):
 *   GET /api/fc/allTimeLeaderboard/search?platform=common-gen5&clubName={name}
 */
async function searchClubsByName(name) {
  const q = name.trim();
  if (!q) return [];

  try {
    const res = await eaClient.get('/allTimeLeaderboard/search', {
      params: {
        platform: PLATFORM,
        clubName: q
      }
    });

    const data = res.data || {};

    // The exact shape can vary; try a few common patterns:
    const candidates =
      data.items ||
      data.clubs ||
      data.result ||
      data.leaderboardEntries ||
      data.entries ||
      [];

    if (!Array.isArray(candidates)) {
      console.warn('⚠️ Unexpected leaderboard search shape:', data);
      return [];
    }

    const results = [];

    for (const item of candidates) {
      if (!item) continue;

      // Try to get clubId & name from a few possible locations
      const clubId =
        item.clubId ||
        item.clubID ||
        (item.club && (item.club.id || item.club.clubId));

      const clubName =
        item.clubName ||
        (item.club && (item.club.name || item.club.clubName)) ||
        item.name ||
        q;

      if (!clubId || !clubName) continue;

      const region =
        item.regionName ||
        item.region ||
        (item.club && (item.club.regionName || item.club.region)) ||
        null;

      const division =
        item.division ||
        item.leagueDivision ||
        (item.club && (item.club.division || item.club.leagueDivision)) ||
        null;

      results.push({
        clubId: String(clubId),
        name: clubName,
        region,
        division
      });
    }

    return results;
  } catch (err) {
    console.error(
      `⚠️ EA leaderboard search error for query="${q}":`,
      err.toString()
    );
    return [];
  }
}

/**
 * Use the FC endpoints you pasted:
 *  - /clubs/info
 *  - /clubs/overallStats
 *  - /clubs/matches?matchType=leagueMatch
 * and build a scouting report via OpenAI.
 */
async function createScoutingReportFromId(clubId, displayName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  // 1) Fetch club info + overall stats + league matches
  const paramsBase = { platform: PLATFORM, clubIds: clubId };

  const [infoRes, overallRes, matchesRes] = await Promise.all([
    eaClient.get('/clubs/info', { params: paramsBase }),
    eaClient.get('/clubs/overallStats', { params: paramsBase }),
    eaClient.get('/clubs/matches', {
      params: {
        ...paramsBase,
        matchType: 'leagueMatch'
      }
    })
  ]);

  const info = infoRes.data;
  const overallStats = overallRes.data;
  const matches = matchesRes.data;

  const inputText =
    `You are an experienced EA FC Pro Clubs tactical analyst. ` +
    `Given raw JSON stats and match history, write a concise scouting report for a competitive team.\n\n` +
    `Focus on:\n` +
    `- Overall quality & record\n` +
    `- Formation and playstyle tendencies (possession, direct, wide/narrow, press/drop off)\n` +
    `- Key players and main threats (goals/assists, ratings, positions)\n` +
    `- Defensive tendencies & weaknesses (goals conceded patterns, clean sheets, discipline)\n` +
    `- Suggested game plan to beat them.\n\n` +
    `Club display name (from Discord): ${displayName}\n` +
    `EA internal club ID: ${clubId}\n` +
    `Platform: ${PLATFORM}\n\n` +
    `Club info JSON (from /clubs/info):\n${JSON.stringify(info)}\n\n` +
    `Club overall stats JSON (from /clubs/overallStats):\n${JSON.stringify(
      overallStats
    )}\n\n` +
    `Recent league matches JSON (from /clubs/matches?matchType=leagueMatch):\n${JSON.stringify(
      matches
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
  return { info, report };
}

// -------------------- READY & COMMAND REGISTRATION --------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`✅ App ID: ${c.application.id}`);

  // Global command for all servers
  await c.application.commands.set([
    {
      name: 'scoutclub',
      description:
        'Look up an EA FC Pro Clubs team and generate a scouting report.',
      options: [
        {
          name: 'name',
          description:
            'Approximate club name as it appears in-game (will search EA leaderboards)',
          type: ApplicationCommandOptionType.String,
          required: false
        },
        {
          name: 'id',
          description:
            'Exact EA club ID (skip search and go straight to scouting)',
          type: ApplicationCommandOptionType.String,
          required: false
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

      if (cmd === 'scoutclub') {
        const clubName = interaction.options.getString('name');
        const clubIdArg = interaction.options.getString('id');

        if (!clubName && !clubIdArg) {
          return interaction.reply({
            content:
              'You need to provide either a **club name** (`name`) or a **club ID** (`id`).',
            ephemeral: true
          });
        }

        await interaction.deferReply();

        // If ID provided, skip search entirely
        if (clubIdArg) {
          const chosenId = clubIdArg.trim();
          const labelName = clubName || `Club ID ${chosenId}`;

          await interaction.editReply(
            `Using **club ID ${chosenId}** on platform **${PLATFORM}**. Generating scouting report…`
          );

          try {
            const { info, report } = await createScoutingReportFromId(
              chosenId,
              labelName
            );

            const titleName =
              (Array.isArray(info) ? info[0]?.name : info?.name) ||
              labelName;
            const text = report || 'No report generated.';
            const trimmed =
              text.length > 4000 ? text.slice(0, 4000) + '…' : text;

            const embed = new EmbedBuilder()
              .setTitle(
                `Scouting report: ${titleName} (${PLATFORM}, ID: ${chosenId})`
              )
              .setDescription(trimmed);

            await interaction.editReply({ content: null, embeds: [embed] });
          } catch (err) {
            console.error('❌ Error creating scouting report by ID:', err);
            await interaction.editReply(
              'I tried to fetch that club by ID, but EA or OpenAI returned an error.'
            );
          }

          return;
        }

        // Otherwise: name-based search via /allTimeLeaderboard/search
        const matches = await searchClubsByName(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on EA FC leaderboards. Try a different spelling or the exact in-game name.'
          );
          return;
        }

        // If only one result, go straight to report
        if (matches.length === 1) {
          const chosen = matches[0];

          await interaction.editReply(
            `Found one match: **${chosen.name}** (ID: ${chosen.clubId}). Generating scouting report…`
          );

          try {
            const { info, report } = await createScoutingReportFromId(
              chosen.clubId,
              chosen.name
            );

            const titleName =
              (Array.isArray(info) ? info[0]?.name : info?.name) ||
              chosen.name;
            const text = report || 'No report generated.';
            const trimmed =
              text.length > 4000 ? text.slice(0, 4000) + '…' : text;

            const embed = new EmbedBuilder()
              .setTitle(
                `Scouting report: ${titleName} (${PLATFORM}, ID: ${chosen.clubId})`
              )
              .setDescription(trimmed);

            await interaction.editReply({ content: null, embeds: [embed] });
          } catch (err) {
            console.error('❌ Error creating scouting report from search:', err);
            await interaction.editReply(
              'I found the club, but failed to generate a scouting report (EA or OpenAI error).'
            );
          }

          return;
        }

        // Multiple results: let user choose from top 5
        const top = matches.slice(0, 5);
        pendingScoutChoices.set(interaction.user.id, {
          query: clubName,
          results: top
        });

        const options = top.map((club, index) => {
          const parts = [];
          if (club.region) parts.push(club.region);
          if (club.division) parts.push(`Div ${club.division}`);
          const extra = parts.length ? ' – ' + parts.join(' / ') : '';

          return {
            label: `${club.name}`,
            description: `ID: ${club.clubId}${extra}`.slice(0, 100),
            value: String(index)
          };
        });

        const select = new StringSelectMenuBuilder()
          .setCustomId('scoutclub_pick')
          .setPlaceholder('Select the correct club')
          .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);

        const lines = top.map((club, index) => {
          const parts = [];
          if (club.region) parts.push(club.region);
          if (club.division) parts.push(`Div ${club.division}`);
          const extra = parts.length ? ' – ' + parts.join(' / ') : '';
          return `**${index + 1}.** ${club.name}${extra} (ID: ${club.clubId})`;
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

        // Clear pending state
        pendingScoutChoices.delete(userId);

        await interaction.deferUpdate();

        // Update original message while we work
        await interaction.editReply({
          content: `Generating scouting report for **${chosen.name}** (ID: ${chosen.clubId}) on **${PLATFORM}**…`,
          embeds: [],
          components: []
        });

        try {
          const { info, report } = await createScoutingReportFromId(
            chosen.clubId,
            chosen.name
          );

          const titleName =
            (Array.isArray(info) ? info[0]?.name : info?.name) ||
            chosen.name;
          const text = report || 'No report generated.';
          const trimmed =
            text.length > 4000 ? text.slice(0, 4000) + '…' : text;

          const embed = new EmbedBuilder()
            .setTitle(
              `Scouting report: ${titleName} (${PLATFORM}, ID: ${chosen.clubId})`
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
