const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ApplicationCommandOptionType,
  MessageFlags
} = require('discord.js');

const axios = require('axios');
const OpenAI = require('openai');

// EA Pro Clubs API wrapper
const {
  getClubInfo,
  getClubStats,
  getClubMatchHistory
} = require('proclubs-api/dist/core/club');

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

const PLATFORMS = ['xboxone', 'ps5', 'ps4', 'pc'];
const PLATFORM_LABELS = {
  xboxone: 'Xbox (One / Series)',
  ps5: 'PlayStation 5',
  ps4: 'PlayStation 4',
  pc: 'PC'
};

// Store pending choices per user for the select menu
// Map<userId, { query: string, results: Array<{ platform, clubId, name, region, division }> }>
const pendingScoutChoices = new Map();

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- EA SEARCH HELPERS --------------------

// Hit EA once per platform and collect all matching clubs
async function searchClubsAcrossPlatforms(query) {
  const results = [];
  const q = query.trim();
  if (!q) return results;

  await Promise.all(
    PLATFORMS.map(async (platform) => {
      try {
        const res = await axios.get(
          'https://proclubs.ea.com/api/fifa/clubs/search',
          {
            params: { clubName: q, platform },
            timeout: 5000
          }
        );

        const clubs = res.data?.clubs || res.data?.result || [];
        if (Array.isArray(clubs)) {
          for (const club of clubs) {
            if (!club) continue;
            results.push({
              platform,
              clubId: String(club.clubId ?? club.club) || '',
              name: club.name || club.clubName || q,
              region: club.regionName || club.region || club.countryName || null,
              division: club.division || club.leagueDivision || null
            });
          }
        }
      } catch (err) {
        console.error(
          `⚠️ EA search error for platform=${platform}, query="${q}":`,
          err.toString()
        );
      }
    })
  );

  // Deduplicate by platform+clubId
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    if (!r.clubId) continue;
    const key = `${r.platform}:${r.clubId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return unique;
}

// -------------------- OPENAI SCOUTING HELPERS --------------------

async function createScoutingReportFromId(platform, clubId, displayName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  // 1) Fetch core club data + stats + recent matches
  const [info, stats, divMatches, cupMatches] = await Promise.all([
    getClubInfo(platform, clubId),
    getClubStats(platform, clubId),
    getClubMatchHistory(platform, clubId, 'matchType9'), // league/division
    getClubMatchHistory(platform, clubId, 'matchType13') // cup
  ]);

  const recentDiv = Array.isArray(divMatches) ? divMatches.slice(0, 20) : [];
  const recentCup = Array.isArray(cupMatches) ? cupMatches.slice(0, 10) : [];

  const inputText =
    `You are an experienced EA FC Pro Clubs tactical analyst. ` +
    `Given raw JSON stats and match history, write a concise scouting report for a competitive team.\n\n` +
    `Focus on:\n` +
    `- Overall quality & record\n` +
    `- Formation and playstyle tendencies (possession, direct, wide/narrow, press/drop off)\n` +
    `- Key players and main threats (goals/assists, ratings, positions)\n` +
    `- Defensive tendencies & weaknesses (goals conceded patterns, clean sheets, discipline)\n` +
    `- Suggested game plan to beat them.\n\n` +
    `Club display name: ${displayName}\n` +
    `EA internal club ID: ${clubId}\n` +
    `Platform: ${platform}\n\n` +
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

      // /scoutclub – search all platforms, then let user pick a club, then generate report
      if (cmd === 'scoutclub') {
        const clubName = interaction.options.getString('name', true);

        await interaction.deferReply();

        const matches = await searchClubsAcrossPlatforms(clubName);

        if (!matches.length) {
          await interaction.editReply(
            'I could not find any clubs matching that name on EA servers. Try a different spelling or the full exact in-game name.'
          );
          return;
        }

        // If only one result, go straight to the report
        if (matches.length === 1) {
          const chosen = matches[0];
          const labelPlatform =
            PLATFORM_LABELS[chosen.platform] || chosen.platform;

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
            PLATFORM_LABELS[club.platform] || club.platform;
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
            PLATFORM_LABELS[club.platform] || club.platform;
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
            flags: MessageFlags.Ephemeral
          });
        }

        const index = parseInt(interaction.values[0], 10);
        const chosen = state.results[index];
        if (!chosen) {
          return interaction.reply({
            content: 'Invalid club selection. Please run `/scoutclub` again.',
            flags: MessageFlags.Ephemeral
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
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

// -------------------- LOGIN --------------------

client.login(token);
