const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ApplicationCommandOptionType
} = require('discord.js');

const OpenAI = require('openai');

// EA Pro Clubs API wrapper
const {
  getClubSearch,
  getClubIdByName,
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
  console.warn('⚠️ OPENAI_API_KEY not set – /scoutclub will not work.');
}
const openai = new OpenAI({ apiKey: openaiApiKey });

// All platforms we’ll search
const PLATFORMS = ['xboxone', 'xbox-series-xs', 'ps5', 'ps4', 'pc'];

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- HELPERS --------------------

// Search club across ALL platforms by name.
// Returns { platform, clubId } or null.
async function findClubOnAnyPlatform(clubName) {
  let foundPlatform = null;
  let foundClubId = null;

  for (const platform of PLATFORMS) {
    try {
      const clubId = await getClubIdByName(platform, clubName);
      if (clubId) {
        foundPlatform = platform;
        foundClubId = clubId;
        break;
      }
    } catch (err) {
      console.error(
        `⚠️ getClubIdByName failed for platform=${platform}, club="${clubName}":`,
        err.message || err
      );
      // keep going, maybe it exists on another platform
    }
  }

  if (!foundPlatform || !foundClubId) return null;
  return { platform: foundPlatform, clubId: foundClubId };
}

// Build scouting report via OpenAI
async function createScoutingReport(clubName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  // 1) Find the club on ANY supported platform
  const clubFound = await findClubOnAnyPlatform(clubName);
  if (!clubFound) {
    throw new Error(
      `Club "${clubName}" not found on any supported platform (${PLATFORMS.join(
        ', '
      )}).`
    );
  }

  const { platform, clubId } = clubFound;

  // 2) Fetch club data + stats + recent matches
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
      description: 'Scout an EA FC Pro Clubs team and get a stats-based report.',
      options: [
        {
          name: 'name',
          description: 'Club name (start typing for suggestions)',
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true
        }
      ]
    }
  ]);

  console.log('✅ Commands registered: /scoutclub (with autocomplete on club name)');
});

// -------------------- INTERACTION HANDLER --------------------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---------- Autocomplete for club name ----------
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== 'scoutclub') return;

      const focused = interaction.options.getFocused(true); // { name, value }
      if (focused.name !== 'name') return;

      const query = (focused.value || '').trim();
      if (!query) {
        return interaction.respond([]);
      }

      const suggestionsMap = new Map();

      for (const platform of PLATFORMS) {
        try {
          const results = await getClubSearch(platform, query);
          if (!Array.isArray(results)) continue;

          for (const club of results) {
            // Try a few possible name fields
            const clubName =
              (club && (club.name || club.clubName || club.clubname)) || '';
            if (!clubName) continue;

            const label = `${clubName} (${platform})`;

            if (!suggestionsMap.has(label)) {
              suggestionsMap.set(label, {
                name: label,
                // Value is just the name; we’ll figure out platform later
                value: clubName
              });
              if (suggestionsMap.size >= 25) break;
            }
          }
        } catch (err) {
          console.error(
            `⚠️ getClubSearch failed for platform=${platform}, query="${query}":`,
            err.message || err
          );
        }
        if (suggestionsMap.size >= 25) break;
      }

      if (suggestionsMap.size === 0) {
        // fallback: just echo what they typed
        return interaction.respond([{ name: query, value: query }]);
      }

      return interaction.respond(Array.from(suggestionsMap.values()));
    }

    // ---------- Slash command ----------
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;

    // /scoutclub – EA Pro Clubs scouting report
    if (cmd === 'scoutclub') {
      const clubName = interaction.options.getString('name');

      await interaction.deferReply();

      try {
        const { platform, info, report } = await createScoutingReport(clubName);

        const titleName = info?.name || clubName;
        const text = report || 'No report generated.';
        const trimmed =
          text.length > 4000 ? text.slice(0, 4000) + '…' : text;

        const embed = new EmbedBuilder()
          .setTitle(
            `Scouting report: ${titleName} (${platform.toUpperCase()})`
          )
          .setDescription(trimmed);

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('❌ Error in /scoutclub:', err);
        await interaction.editReply({
          content:
            'Could not generate scouting report. The club may not exist on any platform, or an API call failed.'
        });
      }

      return;
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
