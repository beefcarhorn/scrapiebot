const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const fs   = require("fs");
const path = require("path");

// ── Configuration ─────────────────────────────────────────────────────────────
const BOT_TOKEN    = "TOKEN_HERE";  // Replace with your bot token
const CLIENT_ID    = "1140696865361367123";  // Replace with your application/client ID
const GUILD_ID     = "556548019449757759";   // Right-click your server → Copy Server ID
const AUDIO_FOLDER = "./rules";              // Folder containing your .wav files
// ──────────────────────────────────────────────────────────────────────────────

// ── Register slash command (guild-scoped = instant) ───────────────────────────
const command = new SlashCommandBuilder()
  .setName("buildchal")
  .setDescription("Join your voice channel and play rule clips at evenly-spaced intervals.")
  .addIntegerOption((opt) =>
    opt
      .setName("minutes")
      .setDescription("Total session length in minutes")
      .setMinValue(1)
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("num_rules")
      .setDescription("Number of rule clips to play evenly across the session")
      .setMinValue(1)
      .setRequired(true)
  );
 
const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
 
(async () => {
  try {
    console.log("Registering slash command...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [command.toJSON()],
    });
    console.log("Slash command registered.");
  } catch (err) {
    console.error("Failed to register slash command:", err);
  }
})();
 
// ── Bot client ────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
 
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});
 
// ── Helpers ───────────────────────────────────────────────────────────────────
 
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
 
function playRandomClip(player, wavFiles) {
  return new Promise((resolve, reject) => {
    const chosen   = wavFiles[Math.floor(Math.random() * wavFiles.length)];
    const fullPath = path.join(AUDIO_FOLDER, chosen);
    const resource = createAudioResource(fullPath);
 
    player.play(resource);
    console.log(`  Playing: ${chosen}`);
 
    const onIdle  = () => { cleanup(); resolve(chosen); };
    const onError = (err) => { cleanup(); reject(err); };
 
    function cleanup() {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off("error", onError);
    }
 
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
  });
}
 
// ── Slash command handler ─────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "buildchal") return;
 
  const minutes  = interaction.options.getInteger("minutes");
  const numRules = interaction.options.getInteger("num_rules");
 
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({
      content: "⚠️ You must be in a voice channel to use this command.",
      ephemeral: true,
    });
  }
 
  if (!fs.existsSync(AUDIO_FOLDER) || !fs.statSync(AUDIO_FOLDER).isDirectory()) {
    return interaction.reply({
      content: `⚠️ Audio folder \`${AUDIO_FOLDER}\` not found.`,
      ephemeral: true,
    });
  }
 
  const wavFiles = fs
    .readdirSync(AUDIO_FOLDER)
    .filter((f) => f.toLowerCase().endsWith(".wav"));
 
  if (wavFiles.length === 0) {
    return interaction.reply({
      content: `⚠️ No \`.wav\` files found in \`${AUDIO_FOLDER}\`.`,
      ephemeral: true,
    });
  }
 
  const totalMs     = minutes * 60 * 1000;
  const intervalMs  = totalMs / numRules;
  const intervalMin = (intervalMs / 60000).toFixed(1);
 
  await interaction.reply(
    `🎙️ Joining **${voiceChannel.name}** — playing **${numRules}** rule(s) ` +
    `over **${minutes}** minute(s) (every ~${intervalMin} min).`
  );
 
  const connection = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId:        voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });
 
  // Log connection state changes to help diagnose issues
  connection.on("stateChange", (oldState, newState) => {
    console.log(`Voice connection: ${oldState.status} → ${newState.status}`);
  });
 
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    console.error("Connection timed out. Final state:", connection.state.status);
    connection.destroy();
    return interaction.followUp("⚠️ Could not connect to the voice channel in time.");
  }
 
  const player = createAudioPlayer();
  connection.subscribe(player);

  await new Promise((resolve, reject) => {
    const resource = createAudioResource("./intro.wav");
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, resolve);
    player.once("error", reject);
  });

  await new Promise((resolve, reject) => {
    const resource = createAudioResource("./countdown.wav");
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, resolve);
    player.once("error", reject);
  });
 
  try {
    for (let i = 1; i <= numRules; i++) {
      if (i > 1) await sleep(intervalMs);
      if (connection.state.status === VoiceConnectionStatus.Destroyed) break;
 
      console.log(`Rule ${i}/${numRules}`);
      await playRandomClip(player, wavFiles);
    }
 
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      await sleep(intervalMs);
    }
  } catch (err) {
    console.error("Playback error:", err);
    await interaction.followUp("⚠️ An error occurred during playback.");
  } finally {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      await new Promise((resolve, reject) => {
        const resource = createAudioResource("./outro.wav");
        player.play(resource);
        player.once(AudioPlayerStatus.Idle, resolve);
        player.once("error", reject);
      });
      connection.destroy();
    }
    await interaction.followUp("✅ Session complete — disconnected from voice.");
  }
});
 
client.login(BOT_TOKEN);