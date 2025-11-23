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

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------------------- SCOUTING HELPER --------------------

async function createScoutingReport(platform, clubName) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  // 1) Find the club ID by name
  const clubId = await getClubIdByName(platform, clubName);
  if (!clubId) {
    throw new Error(`Club "${clubName}" not found on platform "${platform}".`);
  }

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

  return { clubId, info, report };
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
          name: 'platform',
          description: 'Where the club plays',
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: 'Xbox (One / Series)', value: 'xboxone' },
            { name: 'PlayStation 4', value: 'ps4' },
            { name: 'PlayStation 5', value: 'ps5' },
            { name: 'PC', value: 'pc' }
          ]
        },
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

    // /scoutclub – EA Pro Clubs scouting report
    if (cmd === 'scoutclub') {
      const platform = interaction.options.getString('platform');
      const clubName = interaction.options.getString('name');

      await interaction.deferReply();

      try {
        const { info, report } = await createScoutingReport(platform, clubName);

        const titleName = info?.name || clubName;
        const text = report || 'No report generated.';
        const trimmed = text.length > 4000 ? text.slice(0, 4000) + '…' : text;

        const embed = new EmbedBuilder()
          .setTitle(`Scouting report: ${titleName} (${platform.toUpperCase()})`)
          .setDescription(trimmed);

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('❌ Error in /scoutclub:', err);
        await interaction.editReply({
          content:
            'Could not generate scouting report. The club may not exist on that platform, or an API call failed.'
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
