const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ApplicationCommandOptionType
} = require('discord.js');

const OpenAI = require('openai');

// EA Pro Clubs API wrapper
// NOTE: depending on the version of proclubs-api you installed,
// you may need to adjust this path. This is based on the GitHub repo structure.
const {
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

// Platforms we’ll search in order
const PLATFORMS = ['xboxone', 'ps5', 'ps4', 'pc'];

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- SCOUTING HELPER (SEARCH ALL PLATFORMS) --------------------

async function createScoutingReport(clubName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  // 1) Try to find the club ID by name on any platform
  let found = null;

  for (const platform of PLATFORMS) {
    try {
      const clubId = await getClubIdByName(platform, clubName);
      if (clubId) {
        found = { platform, clubId };
        break;
      }
    } catch (err) {
      console.warn(
        `⚠️ Lookup failed for "${clubName}" on ${platform}:`,
        err?.message || err
      );
      // ignore & try next platform
    }
  }

  if (!found) {
    throw new Error(
      `Club "${clubName}" not found on any supported platform (${PLATFORMS.join(', ')}).`
    );
  }

  const { platform, clubId } = found;

  // 2) Fetch core club data + stats + recent matches
  const [info, stats, divMatches, cupMatches] = await Promise.all([
    getClubInfo(platform, clubId),
    getClubStats(platform, clubId),
    getClubMatchHistory(platform, clubId, 'matchType9'),  // league/division
    getClubMatchHistory(platform, clubId, 'matchType13')  // cup
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
    `Detected platform: ${platform}\n\n` +
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

  return { clubId, info, report, platform };
}

// -------------------- READY & COMMAND REGISTRATION --------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`✅ App ID: ${c.application.id}`);

  await c.application.commands.set([
    {
      name: 'scoutclub',
      description:
        'Scout an EA FC Pro Clubs team and get a stats-based report (searches all platforms).',
      options: [
        {
          name: 'name',
          description: 'Exact club name as it appears in-game',
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
  console.log('🔔 Interaction received:', {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    type: interaction.type,
    commandName: interaction.commandName
  });

  try {
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;

    // /scoutclub – EA Pro Clubs scouting report (all platforms)
    if (cmd === 'scoutclub') {
      const clubName = interaction.options.getString('name');

      await interaction.deferReply();

      try {
        const { info, report, platform } = await createScoutingReport(clubName);

        const titleName = info?.name || clubName;
        const text = report || 'No report generated.';
        const trimmed = text.length > 4000 ? text.slice(0, 4000) + '…' : text;

        const embed = new EmbedBuilder()
          .setTitle(
            `Scouting report: ${titleName} (${(platform || 'unknown').toUpperCase()})`
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
