// Discord <-> Fluxer bridge, works across entire guilds / servers.
// Automatically creates webhooks for every channel the bot has permissions to see,
// and either matches by name or by position / channel order.

const { Client: DiscordClient, GatewayIntentBits, Partials, WebhookClient } = require('discord.js');

let FluxerClient, FluxerWebhook;
try {
  ({ Client: FluxerClient, Webhook: FluxerWebhook } = require('@fluxerjs/core'));
} catch (e) {
  console.error('[Bridge] ERROR: @fluxerjs/core not installed. Run: npm install @fluxerjs/core');
  process.exit(1);
}

const messageMaps = {
  discordToFluxer: new Map(),
  fluxerToDiscord: new Map()
};

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function logError(context, error) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${context}:`, error.message || error);
}

class BridgeManager {
  constructor(config) {
    this.config = config;
    this.mappings = new Map();
    this.discordClient = null;
    this.fluxerClient = null;
  }

  async start() {
    log('[Bridge] ========== STARTING BRIDGE ============');

    // Initialize Discord client
    this.discordClient = new DiscordClient({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel]
    });

    this.discordClient.once('ready', () => {
      log('[Discord] Bot is ready! Logged in as:', this.discordClient.user.tag);
    });

    this.discordClient.on('messageCreate', async (message) => {
      if (message.author.bot) return;
      
      const mapping = this.mappings.get(message.channel.id);
      if (!mapping) {
        log('[Discord] Message in unmapped channel:', message.channel.name);
        return;
      }

      log('[Discord] Relaying to Fluxer, channel:', message.channel.name);
      await this.sendToFluxer(message, mapping);
    });

    await this.discordClient.login(this.config.discord.token);

    // Initialize Fluxer client
    this.fluxerClient = new FluxerClient({ intents: 0, waitForGuilds: true });

    this.fluxerClient.once('ready', () => {
      log('[Fluxer] Bot is ready!');
    });

    this.fluxerClient.on('messageCreate', async (message) => {
      if (message.author?.bot) return;

      const mapping = this.mappings.get(message.channelId);
      if (!mapping || !mapping.discordWebhookUrl) {
        if (!mapping) log('[Fluxer] Message in unmapped channel:', message.channelId);
        return;
      }

      log('[Fluxer] Relaying to Discord, channelId:', message.channelId);
      const webhookClient = new WebhookClient({ url: mapping.discordWebhookUrl });
      await this.sendToDiscord(message, webhookClient);
    });

    await this.fluxerClient.login(this.config.fluxer.token);

    // Build mappings and auto-create webhooks
    await this.buildMappingsAndWebhooks();
    log(`[Bridge] Bridge READY! ${this.mappings.size / 2} channel pairs bridged`);
  }

  async buildMappingsAndWebhooks() {
    const discordGuild = await this.discordClient.guilds.fetch(this.config.discord.serverId);
    const fluxerGuild = await this.fluxerClient.guilds.fetch(this.config.fluxer.guildId);
    
    const discordChannels = await discordGuild.channels.fetch();
    const textChannels = discordChannels.filter(c => c.type === 0 || c.type === 5);
    const fluxerChannels = await fluxerGuild.fetchChannels();

    log('[Bridge] Found', textChannels.size, 'Discord channels,', fluxerChannels.length, 'Fluxer channels');

    for (const [, discordChan] of textChannels) {
      const fluxerChan = fluxerChannels.find(c => c.name === discordChan.name);
      if (!fluxerChan) {
        log('[Bridge] No Fluxer match for Discord channel:', discordChan.name);
        continue;
      }

      log('[Bridge] Setting up bridge for:', discordChan.name);
      
      // Create Discord webhook automatically
      let discordWebhookUrl = null;
      try {
        const webhook = await discordChan.createWebhook({
          name: 'Fluxer Bridge',
          avatar: 'https://fluxerstatic.com/web/favicon.ico'
        });
        discordWebhookUrl = webhook.url;
        log('[Bridge] Created Discord webhook for:', discordChan.name);
      } catch (e) {
        logError('Discord webhook creation failed', e);
      }

      // Create Fluxer webhook automatically
      let fluxerWebhook = null;
      try {
        const fluxerChannel = await this.fluxerClient.channels.fetch(fluxerChan.id);
        const webhook = await fluxerChannel.createWebhook({ name: 'Discord Bridge' });
        fluxerWebhook = { id: webhook.id, token: webhook.token };
        log('[Bridge] Created Fluxer webhook for:', discordChan.name);
      } catch (e) {
        logError('Fluxer webhook creation failed', e);
      }

      this.mappings.set(discordChan.id, {
        discordChannelId: discordChan.id,
        fluxerChannelId: fluxerChan.id,
        discordWebhookUrl: discordWebhookUrl,
        fluxerWebhook: fluxerWebhook
      });
      this.mappings.set(fluxerChan.id, {
        discordChannelId: discordChan.id,
        fluxerChannelId: fluxerChan.id,
        discordWebhookUrl: discordWebhookUrl,
        fluxerWebhook: fluxerWebhook
      });
    }
  }

  getFluxerWebhookClient(webhookData) {
    if (!webhookData) return null;
    return FluxerWebhook.fromToken(this.fluxerClient, webhookData.id, webhookData.token);
  }

  async sendToFluxer(message, mapping) {
    try {
      const webhook = this.getFluxerWebhookClient(mapping.fluxerWebhook);
      if (!webhook) {
        log('[Discord->Fluxer] No Fluxer webhook available - skipping');
        return;
      }

      const username = message.author.displayName || message.author.username;
      // Discord avatars may be animated (gif) - use png for safety with format parameter
      let avatarUrl = message.author.displayAvatarURL({ size: 4096, format: 'png' });
      const content = message.content || '';

      // Handle attachments
      if (message.attachments?.size > 0) {
        const attachments = [];
        for (const [, attachment] of message.attachments) {
          attachments.push({
            url: attachment.url,
            name: attachment.name,
            filename: attachment.name
          });
        }

        await webhook.send({
          content: content,
          username: username,
          avatar_url: avatarUrl,
          files: attachments,
          attachments: attachments.map((a, i) => ({
            id: i,
            filename: a.filename,
            name: a.name
          }))
        }, true);
      } else {
        await webhook.send({
          content: content,
          username: username,
          avatar_url: avatarUrl
        }, true);
      }

      log('[Discord->Fluxer] SENT:', (content || '(attachment)').substring(0, 50));
    } catch (error) {
      logError('[Discord->Fluxer] FAILED', error);
    }
  }

  async sendToDiscord(message, webhookClient) {
    try {
      const username = message.author?.username || 'Fluxer User';
      // Fluxer avatars should work as-is
      const avatarUrl = message.author?.avatarURL?.() || undefined;
      
      await webhookClient.send({
        content: message.content || '',
        username: username,
        avatarURL: avatarUrl
      });

      log('[Fluxer->Discord] SENT:', ((message.content || '').substring(0, 50) || '(empty)'));
    } catch (error) {
      logError('[Fluxer->Discord] FAILED', error);
    }
  }

  stop() {
    this.discordClient?.destroy();
    this.fluxerClient?.destroy();
  }
}

module.exports = { BridgeManager, messageMaps };