import { Client, GatewayIntentBits, Partials } from "discord.js";

const required = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CHANNEL_ID"];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  console.log(`Discord bot online as ${client.user.tag}`);
  console.log(`Guild: ${process.env.DISCORD_GUILD_ID}`);
  console.log(`Channel: ${process.env.DISCORD_CHANNEL_ID}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.guildId !== process.env.DISCORD_GUILD_ID) return;
  if (message.channelId !== process.env.DISCORD_CHANNEL_ID) return;

  console.log(JSON.stringify({
    type: "discord_message",
    messageId: message.id,
    author: message.author.username,
    content: message.content,
    channelId: message.channelId,
    guildId: message.guildId,
    createdAt: message.createdAt.toISOString()
  }));
});

client.login(process.env.DISCORD_BOT_TOKEN);
