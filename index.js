// index.js — ScoutBot (FC Pro Clubs Scouting)

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

// For now we only use the cross-gen FC platform that your curls showed.
const EA_PLATFORM = 'common-gen5';

const PLATFORM_LABELS = {
  'common-gen5': 'Cross-Play (Gen 5)'
};

// Store pending choices per user for the select menu
// Map<userId, { query: string, results: Array<{ platform, clubId, name, region, division }> }>
const pendingScoutChoices = new Map();

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- EA HTTP CLIENT --------------------

const eaClient = axios.create({
  baseURL: 'https://proclubs.ea.com/api/fc',
  timeout: 10000,
  headers: {
    // Approximate “real browser” headers from your curls
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    dnt: '1',
    origin: 'https://www.ea.com',
    referer: 'https://www.ea.com/',
    'sec-ch-ua':
      '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'content-type': 'application/json'
  }
});

// -------------------- EA SEARCH HELPERS --------------------

// Use the FC allTimeLeaderboard search endpoint to find clubs by (approx) name
async function searchClubsByName(query) {
  const q = query.trim();
  if (!q) return [];

  try {
    const res = await eaClient.get('/allTimeLeaderboard/search', {
      params: {
        platform: EA_PLATFORM,
        clubName: q
      }
    });

    const data = res.data;

    // From your logs, the response is an ARRAY like:
    // [ { clubId: '104358', clubName: 'RS Academy', platform: 'common-gen5', ... } ]
    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data.results)
      ? data.results
      : [];

    if (!Array.isArray(arr) || arr.length === 0) {
      console.warn('⚠️ No clubs returned from leaderboard search for:', q);
      return [];
    }

    // Map into our internal shape
    const mapped = arr
      .map((entry) => {
        const clubId =
          entry.clubId != null
            ? String(entry.clubId)
            : entry.clubInfo && entry.clubInfo.clubId != null
            ? String(entry.clubInfo.clubId)
            : '';

        if (!clubId) return null;

        const name =
          entry.clubName ||
          (entry.clubInfo && entry.clubInfo.name) ||
          q;

        const region =
          (entry.clubInfo && entry.clubInfo.regionName) ||
          entry.regionName ||
          entry.region ||
          null;

        const division =
          entry.currentDivision ||
          entry.bestDivision ||
          entry.division ||
          null;

        return {
          platform: entry.platform || EA_PLATFORM,
          clubId,
          name,
          region,
          division,
          raw: entry
        };
      })
      .filter(Boolean);

    return mapped;
  } catch (err) {
    console.error(
      `⚠️ EA leaderboard search error for query="${q}":`,
      err.toString()
    );
    return [];
  }
}

// Fetch info + stats + match history for a given club ID
async function fetchClubData(platform, clubId) {
  const paramsBase = { platform, clubIds: String(clubId) };

  const [infoRes, overallRes, matchesRes] = await Promise.all([
    eaClient.get('/clubs/info', { params: paramsBase }),
    eaClient.get('/clubs/overallStats', { params: paramsBase }),
    eaClient.get('/clubs/matches', {
      params: {
        platform,
        clubIds: String(clubId),
        matchType: 'leagueMatch'
      }
    })
  ]);

  // These endpoints often key by clubId or return arrays; be defensive
  const infoData = infoRes.data;
  const overallData = overallRes.data;
  const matchesData = matchesRes.data;

  const info =
    (infoData && infoData[clubId]) ||
    (Array.isArray(infoData) ? infoData[0] : infoData);

  const overall =
    (overallData && overallData[clubId]) ||
    (Array.isArray(overallData) ? overallData[0] : overallData);

  const matchesArr =
    (matchesData && matchesData[clubId]) ||
    (Array.isArray(matchesData) ? matchesData : []);

  const matches = Array.isArray(matchesArr) ? matchesArr.slice(0, 20) : [];

  return { info, overall, matches };
}

// -------------------- OPENAI SCOUTING HELPERS --------------------

async function createScoutingReportFromId(platform, clubId, displayName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const { info, overall, matches } = await fetchClubData(platform, clubId);

  const inputText =
    'You are an experienced EA FC Pro Clubs tactical analyst. ' +
    'Given raw JSON stats and match history, write a concise scouting report for a competitive team.\n\n' +
    'Focus on:\n' +
    '- Overall quality & record\n' +
    '- Formation and playstyle tendencies (possession, direct, wide/narrow, press/drop off)\n' +
    '- Key players and main threats (goals/assists, ratings, positions)\n' +
    '- Defensive tendencies & weaknesses (goals conceded patterns, clean sheets, discipline)\n' +
    '- Suggested game plan to beat them.\n\n' +
    'Club display name: ' +
    displayName +
    '\n' +
    'EA internal club ID: ' +
    clubId +
    '\n' +
    'Platform: ' +
    platform +
    '\n\n' +
    'Club info JSON:\n' +
    JSON.stringify(info) +
    '\n\n' +
    'Club overall stats JSON:\n' +
    JSON.stringify(overall) +
    '\n\n' +
    'Recent league matches JSON (up to 20):\n' +
    JSON.stringify(matches) +
    '\n\n' +
    'If some fields are missing or unclear, say that and base your analysis on what you do have.';

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

      if (cmd === 'scoutclub') {
        const clubName = interaction.options.getString('name', true);

        await interaction.deferReply();

        const matches = await searchClubsByName(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on EA servers. Try a different spelling or the exact in-game name.'
          );
          return;
        }

        // If only one result, go straight to the report
        if (matches.length === 1) {
          const chosen = matches[0];
          const labelPlatform =
            PLATFORM_LABELS[chosen.platform] || chosen.platform;

          await interaction.editReply(
            'Found one match: **' +
              chosen.name +
              '** on **' +
              labelPlatform +
              '** (club ID: ' +
              chosen.clubId +
              '). Generating scouting report…'
          );

          try {
            const { info, report } = await createScoutingReportFromId(
              chosen.platform,
              chosen.clubId,
              chosen.name
            );

            const titleName = (info && info.name) || chosen.name;
            const text = report || 'No report generated.';
            const trimmed =
              text.length > 4000 ? text.slice(0, 4000) + '…' : text;

            const embed = new EmbedBuilder()
              .setTitle(
                'Scouting report: ' +
                  titleName +
                  ' (' +
                  labelPlatform +
                  ', ID: ' +
                  chosen.clubId +
                  ')'
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
            PLATFORM_LABELS[club.platform] || club.platform;
          const labelRegion = club.region ? ' – ' + club.region : '';
          const labelDivision = club.division
            ? ' – Div ' + club.division
            : '';

          return {
            label: club.name + ' (' + labelPlatform + ')',
            description:
              (labelPlatform + labelRegion + labelDivision).slice(0, 100),
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
            PLATFORM_LABELS[club.platform] || club.platform;
          const parts = [labelPlatform];
          if (club.region) parts.push(club.region);
          if (club.division) parts.push('Div ' + club.division);
          const extra = parts.length ? ' – ' + parts.join(' / ') : '';
          return '**' + (index + 1) + '.** ' + club.name + extra;
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
          PLATFORM_LABELS[chosen.platform] || chosen.platform;

        // Acknowledge quickly, then do the heavy work
        await interaction.deferUpdate();

        // Update the original message to show that we're working
        await interaction.editReply({
          content:
            'Generating scouting report for **' +
            chosen.name +
            '** on **' +
            labelPlatform +
            '** (club ID: ' +
            chosen.clubId +
            ')…',
          embeds: [],
          components: []
        });

        try {
          const { info, report } = await createScoutingReportFromId(
            chosen.platform,
            chosen.clubId,
            chosen.name
          );

          const titleName = (info && info.name) || chosen.name;
          const text = report || 'No report generated.';
          const trimmed =
            text.length > 4000 ? text.slice(0, 4000) + '…' : text;

          const embed = new EmbedBuilder()
            .setTitle(
              'Scouting report: ' +
                titleName +
                ' (' +
                labelPlatform +
                ', ID: ' +
                chosen.clubId +
                ')'
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
