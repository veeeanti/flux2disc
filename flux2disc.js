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

// Store message mappings to track which messages correspond across platforms
// Structure: { discordMessageId: fluxerMessageId, fluxerMessageId: discordMessageId }
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
      partials: [Partials.Channel, Partials.Message] // Add Partials.Message for handling deleted messages
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
      const fluxerMessageId = await this.sendToFluxer(message, mapping);
      if (fluxerMessageId) {
        // Store the mapping for updates/deletes
        messageMaps.discordToFluxer.set(message.id, fluxerMessageId);
        messageMaps.fluxerToDiscord.set(fluxerMessageId, message.id);
      }
    });

    this.discordClient.on('messageUpdate', async (oldMessage, newMessage) => {
      // Ignore if bot's own message or if it's a partial that wasn't cached
      if (newMessage.author.bot || !newMessage.content) return;

      const mapping = this.mappings.get(newMessage.channel.id);
      if (!mapping) {
        log('[Discord] Message update in unmapped channel:', newMessage.channel.name);
        return;
      }

      // Check if we have a mapping for this message
      const fluxerMessageId = messageMaps.discordToFluxer.get(newMessage.id);
      if (!fluxerMessageId) {
        log('[Discord] No Fluxer mapping found for message:', newMessage.id);
        return;
      }

      log('[Discord] Updating message in Fluxer, channel:', newMessage.channel.name);
      await this.updateFluxerMessage(newMessage, mapping, fluxerMessageId);
    });

    this.discordClient.on('messageDelete', async (message) => {
      if (message.author.bot) return;

      const mapping = this.mappings.get(message.channel.id);
      if (!mapping) {
        log('[Discord] Message delete in unmapped channel:', message.channel.name);
        return;
      }

      // Check if we have a mapping for this message
      const fluxerMessageId = messageMaps.discordToFluxer.get(message.id);
      if (!fluxerMessageId) {
        log('[Discord] No Fluxer mapping found for deleted message:', message.id);
        return;
      }

      log('[Discord] Deleting message in Fluxer, channel:', message.channel.name);
      await this.deleteFluxerMessage(mapping, fluxerMessageId);
      
      // Clean up mappings
      messageMaps.discordToFluxer.delete(message.id);
      messageMaps.fluxerToDiscord.delete(fluxerMessageId);
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
      const discordMessageId = await this.sendToDiscord(message, mapping);
      if (discordMessageId) {
        // Store the mapping for updates/deletes
        messageMaps.fluxerToDiscord.set(message.id, discordMessageId);
        messageMaps.discordToFluxer.set(discordMessageId, message.id);
      }
    });

    this.fluxerClient.on('messageUpdate', async (_oldMessage, newMessage) => {
      // Ignore if bot's own message
      if (newMessage.author?.bot) return;

      const mapping = this.mappings.get(newMessage.channelId);
      if (!mapping || !mapping.discordWebhookUrl) {
        log('[Fluxer] Message update in unmapped channel:', message.channelId);
        return;
      }

      // Check if we have a mapping for this message
      const discordMessageId = messageMaps.fluxerToDiscord.get(newMessage.id);
      if (!discordMessageId) {
        log('[Fluxer] No Discord mapping found for message:', newMessage.id);
        return;
      }

      log('[Fluxer] Updating message in Discord, channelId:', newMessage.channelId);
      await this.updateDiscordMessage(newMessage, mapping, discordMessageId);
    });

    this.fluxerClient.on('messageDelete', async (message) => {
      if (message.author?.bot) return;

      const mapping = this.mappings.get(message.channelId);
      if (!mapping || !mapping.discordWebhookUrl) {
        log('[Fluxer] Message delete in unmapped channel:', message.channelId);
        return;
      }

      // Check if we have a mapping for this message
      const discordMessageId = messageMaps.fluxerToDiscord.get(message.id);
      if (!discordMessageId) {
        log('[Fluxer] No Discord mapping found for deleted message:', message.id);
        return;
      }

      log('[Fluxer] Deleting message in Discord, channelId:', message.channelId);
      await this.deleteDiscordMessage(mapping, discordMessageId);
      
      // Clean up mappings
      messageMaps.fluxerToDiscord.delete(message.id);
      messageMaps.discordToFluxer.delete(discordMessageId);
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

    const mappingData = [];

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

      const mapping = {
        discordChannelId: discordChan.id,
        discordChannelName: discordChan.name,
        fluxerChannelId: fluxerChan.id,
        fluxerChannelName: fluxerChan.name,
        discordWebhookUrl: discordWebhookUrl,
        fluxerWebhook: fluxerWebhook
      };

      this.mappings.set(discordChan.id, mapping);
      this.mappings.set(fluxerChan.id, mapping);

      mappingData.push({
        channelName: discordChan.name,
        discordChannelId: discordChan.id,
        fluxerChannelId: fluxerChan.id,
        discordWebhookUrl: discordWebhookUrl,
        fluxerWebhook: fluxerWebhook
      });
    }

    // Save mappings to file
    const fs = require('fs');
    const path = require('path');
    const outputPath = path.join(process.cwd(), 'webhook-mappings.json');
    fs.writeFileSync(outputPath, JSON.stringify(mappingData, null, 2));
    log('[Bridge] Saved webhook mappings to:', outputPath);
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
        return null;
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

        const sentMessage = await webhook.send({
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

        log('[Discord->Fluxer] SENT:', (content || '(attachment)').substring(0, 50));
        return sentMessage.id; // Return the sent message ID
      } else {
        const sentMessage = await webhook.send({
          content: content,
          username: username,
          avatar_url: avatarUrl
        }, true);

        log('[Discord->Fluxer] SENT:', (content || '(attachment)').substring(0, 50));
        return sentMessage.id; // Return the sent message ID
      }
    } catch (error) {
      logError('[Discord->Fluxer] FAILED', error);
      return null;
    }
  }

  async sendToDiscord(message, mapping) {
    try {
      const webhookClient = new WebhookClient({ url: mapping.discordWebhookUrl });
      const username = message.author?.username || 'Fluxer User';
      // Fluxer avatars should work as-is
      const avatarUrl = message.author?.avatarURL?.() || undefined;
      
      const sentMessage = await webhookClient.send({
        content: message.content || '',
        username: username,
        avatarURL: avatarUrl
      });

      log('[Fluxer->Discord] SENT:', ((message.content || '').substring(0, 50) || '(empty)'));
      return sentMessage.id; // Return the sent message ID
    } catch (error) {
      logError('[Fluxer->Discord] FAILED', error);
      return null;
    }
  }

  async updateFluxerMessage(message, mapping, fluxerMessageId) {
    try {
      const webhook = this.getFluxerWebhookClient(mapping.fluxerWebhook);
      if (!webhook) {
        log('[Discord->Fluxer] No Fluxer webhook available for update - skipping');
        return;
      }

      const username = message.author.displayName || message.author.username;
      let avatarUrl = message.author.displayAvatarURL({ size: 4096, format: 'png' });
      const content = message.content || '';

      // Handle attachments (simplified - in practice you might need to re-upload)
      if (message.attachments?.size > 0) {
        const attachments = [];
        for (const [, attachment] of message.attachments) {
          attachments.push({
            url: attachment.url,
            name: attachment.name,
            filename: attachment.name
          });
        }

        await webhook.editMessage(fluxerMessageId, {
          content: content,
          username: username,
          avatar_url: avatarUrl,
          files: attachments,
          attachments: attachments.map((a, i) => ({
            id: i,
            filename: a.filename,
            name: a.name
          }))
        });
      } else {
        await webhook.editMessage(fluxerMessageId, {
          content: content,
          username: username,
          avatar_url: avatarUrl
        });
      }

      log('[Discord->Fluxer] UPDATED message:', fluxerMessageId);
    } catch (error) {
      logError('[Discord->Fluxer] UPDATE FAILED', error);
    }
  }

  async deleteFluxerMessage(mapping, fluxerMessageId) {
    try {
      const webhook = this.getFluxerWebhookClient(mapping.fluxerWebhook);
      if (!webhook) {
        log('[Discord->Fluxer] No Fluxer webhook available for delete - skipping');
        return;
      }

      await webhook.deleteMessage(fluxerMessageId);
      log('[Discord->Fluxer] DELETED message:', fluxerMessageId);
    } catch (error) {
      logError('[Discord->Fluxer] DELETE FAILED', error);
    }
  }

  async updateDiscordMessage(message, mapping, discordMessageId) {
    try {
      const webhookClient = new WebhookClient({ url: mapping.discordWebhookUrl });
      const username = message.author?.username || 'Fluxer User';
      const avatarUrl = message.author?.avatarURL?.() || undefined;
      
      await webhookClient.editMessage(discordMessageId, {
        content: message.content || '',
        username: username,
        avatarURL: avatarUrl
      });

      log('[Fluxer->Discord] UPDATED message:', discordMessageId);
    } catch (error) {
      logError('[Fluxer->Discord] UPDATE FAILED', error);
    }
  }

  async deleteDiscordMessage(mapping, discordMessageId) {
    try {
      const webhookClient = new WebhookClient({ url: mapping.discordWebhookUrl });
      await webhookClient.deleteMessage(discordMessageId);
      log('[Fluxer->Discord] DELETED message:', discordMessageId);
    } catch (error) {
      logError('[Fluxer->Discord] DELETE FAILED', error);
    }
  }

  stop() {
    this.discordClient?.destroy();
    this.fluxerClient?.destroy();
  }
}

module.exports = { BridgeManager, messageMaps };