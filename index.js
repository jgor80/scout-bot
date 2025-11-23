const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ApplicationCommandOptionType
} = require('discord.js');

// EA Pro Clubs API wrapper (path may need tweaking depending on the package version)
const {
  getClubIdByName,
  getClubInfo,
  getClubStats,
  getClubMatchHistory
} = require('proclubs-api/dist/core/club');

const OpenAI = require('openai');

// Get tokens from environment variables only
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

// Add GuildVoiceStates so we can see who is in voice channels
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// Positions to track
const POSITIONS = [
  'ST',
  'RW',
  'LW',
  'CAM',
  'RDM',
  'LDM',
  'LB',
  'LCB',
  'RCB',
  'RB',
  'GK'
];

// Club definitions (generic; configurable via panel buttons)
let CLUBS = [
  { key: 'club1', name: 'Club 1', enabled: true },
  { key: 'club2', name: 'Club 2', enabled: false },
  { key: 'club3', name: 'Club 3', enabled: false },
  { key: 'club4', name: 'Club 4', enabled: false }
];

// Helpers to find clubs
function getClubByKey(key) {
  return CLUBS.find((c) => c.key === key);
}

// Helper: who can manage spots? Admins or users with a "captain"-style role
function isManager(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
  if (member.roles?.cache) {
    return member.roles.cache.some((role) => /captain/i.test(role.name));
  }
  return false;
}

// Global multi-club board state:
// clubKey -> { spots: { [pos]: { open: boolean, takenBy: string | null } } }
const boardState = {};
CLUBS.forEach((club) => {
  boardState[club.key] = {
    spots: POSITIONS.reduce((acc, p) => {
      acc[p] = { open: true, takenBy: null }; // true = OPEN, false = TAKEN
      return acc;
    }, {})
  };
});

// Which club the admin panel is currently editing
let currentClubKey = 'club1';

// Track the admin panel message so we can update it
let adminPanelChannelId = null;
let adminPanelMessageId = null;

// ----- SCOUTING HELPER -----
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
      { role: 'user', content: inputText }
    ]
  });

  const report = response.output_text || 'No report text returned.';

  return { clubId, info, report };
}

// Build the main embed for a given club key
function buildEmbedForClub(clubKey) {
  const club = getClubByKey(clubKey);
  if (!club) {
    throw new Error(`Unknown club key: ${clubKey}`);
  }

  const clubBoard = boardState[clubKey];
  const lines = POSITIONS.map((p) => {
    const slot = clubBoard.spots[p];
    const open = slot.open;
    const emoji = open ? '🟢' : '🔴';
    let text;
    if (open) {
      text = 'OPEN';
    } else if (slot.takenBy) {
      text = `TAKEN by <@${slot.takenBy}>`;
    } else {
      text = 'TAKEN';
    }
    return `**${p}** – ${emoji} ${text}`;
  });

  return new EmbedBuilder()
    .setTitle('Club Spots')
    .setDescription(`**Club:** ${club.name}\n\n` + lines.join('\n'))
    .setFooter({
      text:
        'Players: click a spot to claim. Admins/Captains: use the panel controls to manage spots & clubs.'
    });
}

// Build position buttons (for the CURRENT club in the panel)
function buildButtons() {
  const clubBoard = boardState[currentClubKey];
  const rows = [];
  let currentRow = new ActionRowBuilder();

  POSITIONS.forEach((p, index) => {
    const slot = clubBoard.spots[p];
    const open = slot.open;
    const button = new ButtonBuilder()
      .setCustomId(`pos_${p}`)
      .setLabel(p)
      .setStyle(open ? ButtonStyle.Success : ButtonStyle.Danger); // green=open, red=taken

    currentRow.addComponents(button);

    if (currentRow.components.length === 5 || index === POSITIONS.length - 1) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  });

  return rows;
}

// Build club dropdown (for admin panel)
function buildClubSelect() {
  const enabledClubs = CLUBS.filter((club) => club.enabled);
  const select = new StringSelectMenuBuilder()
    .setCustomId('club_select')
    .setPlaceholder('Select club')
    .addOptions(
      enabledClubs.map((club) => ({
        label: club.name,
        value: club.key,
        default: club.key === currentClubKey
      }))
    );

  const row = new ActionRowBuilder().addComponents(select);
  return row;
}

// Build viewer dropdown (for public read-only board)
function buildViewerClubSelect(selectedKey) {
  const enabledClubs = CLUBS.filter((club) => club.enabled);
  const select = new StringSelectMenuBuilder()
    .setCustomId('viewer_club_select')
    .setPlaceholder('Select club')
    .addOptions(
      enabledClubs.map((club) => ({
        label: club.name,
        value: club.key,
        default: club.key === selectedKey
      }))
    );

  const row = new ActionRowBuilder().addComponents(select);
  return row;
}

// Components for the admin panel (dropdown + controls + position buttons)
function buildAdminComponents() {
  const clubRow = buildClubSelect();

  // Control row: rename + add club + remove club + assign player + reset spots
  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rename_club')
      .setLabel('Rename Club')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('add_club')
      .setLabel('Add Club')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('remove_club')
      .setLabel('Remove Club')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('assign_player')
      .setLabel('Assign Player')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('reset_spots')
      .setLabel('Reset Spots')
      .setStyle(ButtonStyle.Secondary)
  );

  const buttonRows = buildButtons();
  return [clubRow, controlRow, ...buttonRows];
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`✅ App ID: ${c.application.id}`);

  await c.application.commands.set([
    {
      name: 'spotpanel',
      description: 'Create the control panel for club spots.'
    },
    {
      name: 'spots',
      description: 'Show a read-only board with club dropdown.'
    },
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

  console.log('✅ Commands registered: /spotpanel, /spots, /scoutclub');
});

client.on(Events.InteractionCreate, async (interaction) => {
  console.log('🔔 Interaction received:', {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    type: interaction.type,
    commandName: interaction.commandName,
    customId: interaction.customId
  });

  try {
    if (!interaction.guildId || !interaction.channelId) return;

    // Slash commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // /spotpanel – admin/captain control panel
      if (cmd === 'spotpanel') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can create the control panel.',
            ephemeral: true
          });
        }

        const msg = await interaction.reply({
          embeds: [buildEmbedForClub(currentClubKey)],
          components: buildAdminComponents(),
          fetchReply: true
        });

        adminPanelChannelId = interaction.channelId;
        adminPanelMessageId = msg.id;

        console.log('✅ Admin panel created at', {
          channelId: adminPanelChannelId,
          messageId: adminPanelMessageId
        });

        return;
      }

      // /spots – public read-only board
      if (cmd === 'spots') {
        // Default to whichever club the panel is currently editing, if it's enabled
        let key = currentClubKey;
        const currentClub = getClubByKey(key);
        if (!currentClub || !currentClub.enabled) {
          const firstEnabled = CLUBS.find((c) => c.enabled) || CLUBS[0];
          key = firstEnabled ? firstEnabled.key : currentClubKey;
        }

        return interaction.reply({
          embeds: [buildEmbedForClub(key)],
          components: [buildViewerClubSelect(key)],
          ephemeral: false
        });
      }

      // /scoutclub – EA Pro Clubs scouting report
      if (cmd === 'scoutclub') {
        const platform = interaction.options.getString('platform');
        const clubName = interaction.options.getString('name');

        await interaction.deferReply();

        try {
          const { info, report } = await createScoutingReport(platform, clubName);

          const titleName = info?.name || clubName;
          const text = report || 'No report generated.';
          const trimmed =
            text.length > 4000 ? text.slice(0, 4000) + '…' : text;

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
    }

    // Buttons (admin panel: manage clubs + assign VC players + reset + players self-claim spots)
    if (interaction.isButton()) {
      // Handle rename button
      if (interaction.customId === 'rename_club') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can rename clubs.',
            ephemeral: true
          });
        }

        const currentClub = getClubByKey(currentClubKey);
        if (!currentClub) {
          return interaction.reply({
            content: 'Current club not found.',
            ephemeral: true
          });
        }

        const modal = new ModalBuilder()
          .setCustomId('rename_club_modal')
          .setTitle('Rename Club')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('club_name')
                .setLabel('New club name')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(currentClub.name)
            )
          );

        await interaction.showModal(modal);
        return;
      }

      // Handle add-club button
      if (interaction.customId === 'add_club') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can add clubs.',
            ephemeral: true
          });
        }

        // Find first disabled club slot
        const disabledClub = CLUBS.find((c) => !c.enabled);
        if (!disabledClub) {
          return interaction.reply({
            content: 'All available club slots are already in use (max 4).',
            ephemeral: true
          });
        }

        disabledClub.enabled = true;

        // Initialize board state for this club if needed
        if (!boardState[disabledClub.key]) {
          boardState[disabledClub.key] = { spots: {} };
        }
        boardState[disabledClub.key].spots = POSITIONS.reduce((acc, p) => {
          acc[p] = { open: true, takenBy: null };
          return acc;
        }, {});

        // Switch panel to this new club
        currentClubKey = disabledClub.key;

        // Update admin panel message
        if (adminPanelChannelId && adminPanelMessageId) {
          try {
            const channel = await client.channels.fetch(adminPanelChannelId);
            const msg = await channel.messages.fetch(adminPanelMessageId);
            await msg.edit({
              embeds: [buildEmbedForClub(currentClubKey)],
              components: buildAdminComponents()
            });
          } catch (err) {
            console.error('⚠️ Failed to update admin panel after add_club:', err);
          }
        }

        return interaction.reply({
          content: `Added a new club slot: **${disabledClub.name}**. Use "Rename Club" to give it a custom name.`,
          ephemeral: true
        });
      }

      // Handle remove-club button
      if (interaction.customId === 'remove_club') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can remove clubs.',
            ephemeral: true
          });
        }

        const currentClub = getClubByKey(currentClubKey);
        if (!currentClub || !currentClub.enabled) {
          return interaction.reply({
            content: 'Current club cannot be removed.',
            ephemeral: true
          });
        }

        const enabledCount = CLUBS.filter((c) => c.enabled).length;
        if (enabledCount <= 1) {
          return interaction.reply({
            content: 'You must keep at least one club enabled.',
            ephemeral: true
          });
        }

        const clubBoard = boardState[currentClubKey];
        if (clubBoard && clubBoard.spots) {
          const hasTaken = POSITIONS.some((p) => {
            const s = clubBoard.spots[p];
            return s && s.open === false;
          });

          if (hasTaken) {
            return interaction.reply({
              content:
                'This club still has taken spots. Free all spots first (use Reset Spots button or players unclaim) before removing it.',
              ephemeral: true
            });
          }
        }

        // Disable this club
        currentClub.enabled = false;

        // Clear its board
        if (clubBoard && clubBoard.spots) {
          POSITIONS.forEach((p) => {
            if (clubBoard.spots[p]) {
              clubBoard.spots[p].open = true;
              clubBoard.spots[p].takenBy = null;
            }
          });
        }

        // Switch to first remaining enabled club
        const firstEnabled = CLUBS.find((c) => c.enabled);
        if (firstEnabled) {
          currentClubKey = firstEnabled.key;
        }

        // Update admin panel message
        if (adminPanelChannelId && adminPanelMessageId) {
          try {
            const channel = await client.channels.fetch(adminPanelChannelId);
            const msg = await channel.messages.fetch(adminPanelMessageId);
            await msg.edit({
              embeds: [buildEmbedForClub(currentClubKey)],
              components: buildAdminComponents()
            });
          } catch (err) {
            console.error('⚠️ Failed to update admin panel after remove_club:', err);
          }
        }

        return interaction.reply({
          content: `Removed club **${currentClub.name}** from the panel.`,
          ephemeral: true
        });
      }

      // Handle Reset Spots button
      if (interaction.customId === 'reset_spots') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can reset spots.',
            ephemeral: true
          });
        }

        const clubBoard = boardState[currentClubKey];
        POSITIONS.forEach((p) => {
          clubBoard.spots[p].open = true;
          clubBoard.spots[p].takenBy = null;
        });

        // Update admin panel if it exists
        if (adminPanelChannelId && adminPanelMessageId) {
          try {
            const channel = await client.channels.fetch(adminPanelChannelId);
            const msg = await channel.messages.fetch(adminPanelMessageId);
            await msg.edit({
              embeds: [buildEmbedForClub(currentClubKey)],
              components: buildAdminComponents()
            });
          } catch (err) {
            console.error('⚠️ Failed to update admin panel after reset_spots:', err);
          }
        }

        return interaction.reply({
          content: 'All spots set to 🟢 OPEN for the current club.',
          ephemeral: true
        });
      }

      // Handle Assign Player button (manager picks player then spot)
      if (interaction.customId === 'assign_player') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can assign players.',
            ephemeral: true
          });
        }

        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
          return interaction.reply({
            content:
              'You must be in a voice channel with the players you want to assign.',
            ephemeral: true
          });
        }

        const members = [...voiceChannel.members.values()].filter(
          (m) => !m.user.bot
        );
        if (members.length === 0) {
          return interaction.reply({
            content: 'No non-bot players found in your voice channel to assign.',
            ephemeral: true
          });
        }

        const options = members.map((m) => ({
          label: m.displayName || m.user.username,
          value: m.id
        }));

        const select = new StringSelectMenuBuilder()
          .setCustomId(`assign_player_pick_${currentClubKey}`)
          .setPlaceholder('Pick a player')
          .addOptions(options.slice(0, 25));

        const row = new ActionRowBuilder().addComponents(select);
        const club = getClubByKey(currentClubKey);

        return interaction.reply({
          content: `Pick a player to assign in **${club ? club.name : currentClubKey}**:`,
          components: [row],
          ephemeral: true
        });
      }

      // Position buttons: players (and managers) self-claim / free their own spot
      if (interaction.customId.startsWith('pos_')) {
        const pos = interaction.customId.substring('pos_'.length);
        const clubBoard = boardState[currentClubKey];
        if (!clubBoard || !clubBoard.spots.hasOwnProperty(pos)) return;

        const inVoice = interaction.member?.voice?.channelId;
        if (!inVoice) {
          return interaction.reply({
            content: 'You must be connected to a voice channel to claim or free a spot.',
            ephemeral: true
          });
        }

        const userId = interaction.user.id;
        const slot = clubBoard.spots[pos];

        if (slot.open) {
          // Claim: clear any other spots this user holds in this club
          for (const p of POSITIONS) {
            const s = clubBoard.spots[p];
            if (s && s.takenBy === userId) {
              s.open = true;
              s.takenBy = null;
            }
          }
          slot.open = false;
          slot.takenBy = userId;
        } else {
          // Slot is taken
          if (slot.takenBy === userId) {
            // User frees their own spot
            slot.open = true;
            slot.takenBy = null;
          } else {
            return interaction.reply({
              content:
                'This spot is already taken by someone else. Ask a captain if you need to be moved.',
              ephemeral: true
            });
          }
        }

        return interaction.update({
          embeds: [buildEmbedForClub(currentClubKey)],
          components: buildAdminComponents()
        });
      }
    }

    // Modal submissions (rename club)
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'rename_club_modal') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can rename clubs.',
            ephemeral: true
          });
        }

        const newName = interaction.fields.getTextInputValue('club_name').trim();
        if (!newName) {
          return interaction.reply({
            content: 'Club name cannot be empty.',
            ephemeral: true
          });
        }

        const currentClub = getClubByKey(currentClubKey);
        if (!currentClub) {
          return interaction.reply({
            content: 'Current club not found.',
            ephemeral: true
          });
        }

        currentClub.name = newName;

        // Update admin panel if it exists
        if (adminPanelChannelId && adminPanelMessageId) {
          try {
            const channel = await client.channels.fetch(adminPanelChannelId);
            const msg = await channel.messages.fetch(adminPanelMessageId);
            await msg.edit({
              embeds: [buildEmbedForClub(currentClubKey)],
              components: buildAdminComponents()
            });
          } catch (err) {
            console.error('⚠️ Failed to update admin panel after rename:', err);
          }
        }

        return interaction.reply({
          content: `Club renamed to **${newName}**.`,
          ephemeral: true
        });
      }
    }

    // Dropdowns (club select, public viewer select, and assignment selects)
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      // Public viewer club select (/spots board)
      if (id === 'viewer_club_select') {
        const selectedKey = interaction.values[0];
        const club = getClubByKey(selectedKey);
        if (!club || !club.enabled) {
          return interaction.reply({
            content: 'Unknown or disabled club selected.',
            ephemeral: true
          });
        }

        return interaction.update({
          embeds: [buildEmbedForClub(selectedKey)],
          components: [buildViewerClubSelect(selectedKey)]
        });
      }

      // Change which club we're editing in the panel
      if (id === 'club_select') {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can change the club.',
            ephemeral: true
          });
        }

        const selectedKey = interaction.values[0];
        const club = getClubByKey(selectedKey);
        if (!club) {
          return interaction.reply({
            content: 'Unknown club selected.',
            ephemeral: true
          });
        }

        currentClubKey = selectedKey;

        return interaction.update({
          embeds: [buildEmbedForClub(currentClubKey)],
          components: buildAdminComponents()
        });
      }

      // First step of manager assignment: pick player
      if (id.startsWith('assign_player_pick_')) {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can assign players.',
            ephemeral: true
          });
        }

        const clubKey = id.substring('assign_player_pick_'.length);
        const club = getClubByKey(clubKey);
        if (!club) {
          return interaction.reply({
            content: 'Unknown club in assignment request.',
            ephemeral: true
          });
        }

        const userId = interaction.values[0];

        const posSelect = new StringSelectMenuBuilder()
          .setCustomId(`assign_player_pos_${clubKey}_${userId}`)
          .setPlaceholder('Pick a spot')
          .addOptions(POSITIONS.map((p) => ({ label: p, value: p })));

        const row = new ActionRowBuilder().addComponents(posSelect);

        return interaction.update({
          content: `Now pick a spot for <@${userId}> in **${club.name}**:`,
          components: [row]
        });
      }

      // Second step of manager assignment: pick spot
      if (id.startsWith('assign_player_pos_')) {
        if (!isManager(interaction.member)) {
          return interaction.reply({
            content: 'Only admins or captains can assign players.',
            ephemeral: true
          });
        }

        const parts = id.split('_'); // ['assign', 'player', 'pos', clubKey, userId]
        const clubKey = parts[3];
        const userId = parts[4];
        const pos = interaction.values[0];

        const club = getClubByKey(clubKey);
        if (!club) {
          return interaction.reply({
            content: 'Unknown club in assignment request.',
            ephemeral: true
          });
        }

        const clubBoard = boardState[clubKey];
        if (!clubBoard || !clubBoard.spots[pos]) {
          return interaction.reply({
            content: 'Unknown position for this club.',
            ephemeral: true
          });
        }

        // Clear any spots this user holds in this club
        for (const p of POSITIONS) {
          const s = clubBoard.spots[p];
          if (s && s.takenBy === userId) {
            s.open = true;
            s.takenBy = null;
          }
        }

        // Assign to chosen spot (override previous occupant)
        const slot = clubBoard.spots[pos];
        slot.open = false;
        slot.takenBy = userId;

        // If this is the currently displayed club, update the admin panel
        if (clubKey === currentClubKey && adminPanelChannelId && adminPanelMessageId) {
          try {
            const channel = await client.channels.fetch(adminPanelChannelId);
            const msg = await channel.messages.fetch(adminPanelMessageId);
            await msg.edit({
              embeds: [buildEmbedForClub(currentClubKey)],
              components: buildAdminComponents()
            });
          } catch (err) {
            console.error('⚠️ Failed to update admin panel after assignment:', err);
          }
        }

        return interaction.update({
          content: `Assigned <@${userId}> to **${pos}** in **${club.name}**.`,
          components: []
        });
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

// When someone leaves voice, clear any spots they held
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    // Only care about leaving all voice channels in this guild
    // oldState.channelId exists (they were in VC)
    // newState.channelId is null (they disconnected)
    if (!oldState.guild || !oldState.channelId) return;
    if (newState.channelId) return; // still in some VC, ignore

    const userId = oldState.id;
    const touchedClubKeys = new Set();

    // Look through every club and clear any spots held by this user
    for (const clubKey of Object.keys(boardState)) {
      const clubBoard = boardState[clubKey];
      if (!clubBoard || !clubBoard.spots) continue;

      let changed = false;

      for (const pos of POSITIONS) {
        const slot = clubBoard.spots[pos];
        if (slot && slot.takenBy === userId) {
          slot.open = true;
          slot.takenBy = null;
          changed = true;
        }
      }

      if (changed) touchedClubKeys.add(clubKey);
    }

    // If the currently displayed club was changed, update the admin panel message
    if (
      touchedClubKeys.has(currentClubKey) &&
      adminPanelChannelId &&
      adminPanelMessageId
    ) {
      try {
        const channel = await client.channels.fetch(adminPanelChannelId);
        const msg = await channel.messages.fetch(adminPanelMessageId);
        await msg.edit({
          embeds: [buildEmbedForClub(currentClubKey)],
          components: buildAdminComponents()
        });
      } catch (err) {
        console.error('⚠️ Failed to update admin panel after voice leave:', err);
      }
    }
  } catch (err) {
    console.error('❌ Error in VoiceStateUpdate handler:', err);
  }
});

client.login(token);
