// Guild-Wide Fluxer-Discord Bridge Implementation
// Uses channel name/position matching for automatic routing

const { Client, GatewayIntentBits, Partials, WebhookClient } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const WebSocket = require('ws');

// In-memory message ID mappings for reply threading
const messageMaps = {
  discordToFluxer: new Map(),
  fluxerToDiscord: new Map()
};

// ============ FLUXER CLIENT ============

class FluxerClient {
  constructor(config) {
    this.baseUrl = config.baseUrl || 'https://api.fluxer.app/v1';
    this.token = config.token;
    this.websocketUrl = config.websocketUrl;
    this.ws = null;
    this.channels = [];
  }

  async connect() {
    // Connect to Fluxer Gateway WebSocket
    this.ws = new WebSocket(`${this.websocketUrl}?token=${this.token}`);

    this.ws.on('open', () => {
      console.log('[Fluxer] Connected to gateway');
      // Send hello/identify
      this.ws.send(JSON.stringify({
        op: 0,
        d: {
          token: this.token
        }
      }));
    });

    this.ws.on('message', (data) => {
      const event = JSON.parse(data);
      this.handleGatewayEvent(event);
    });

    this.ws.on('close', () => {
      console.log('[Fluxer] Disconnected from gateway');
    });

    this.ws.on('error', (err) => {
      console.error('[Fluxer] WebSocket error:', err.message);
    });
  }

  async handleGatewayEvent(event) {
    // Route through the bridge manager when available
    if (this.onMessage) {
      await this.onMessage(event);
    }
  }

  async getChannels(guildId) {
    const res = await axios.get(`${this.baseUrl}/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${this.token}` }
    });
    this.channels = res.data;
    return this.channels;
  }

  async sendMessage(channelId, content, options = {}) {
    const res = await axios.post(`${this.baseUrl}/channels/${channelId}/messages`, {
      content,
      ...options
    }, {
      headers: { Authorization: `Bot ${this.token}` }
    });
    return res.data;
  }
}

// ============ GUILD MAPPINGS BUILDER ============

async function buildGuildMappings(config, discordClient, fluxerClient) {
  const mappings = new Map();

  if (config.channelMapping === 'by_name') {
    const discordGuild = await discordClient.guilds.fetch(config.discord.serverId);
    const fluxerChannels = await fluxerClient.getChannels(config.fluxer.guildId);

    const discordChannels = await discordGuild.channels.fetch();
    const textChannels = discordChannels.filter(c => c.type === 0 || c.type === 5);

    for (const [, discordChan] of textChannels) {
      const matchingFluxerChan = fluxerChannels.find(c => c.name === discordChan.name);
      if (matchingFluxerChan) {
        mappings.set(discordChan.id, {
          discordChannelId: discordChan.id,
          fluxerChannelId: matchingFluxerChan.id,
          discordWebhookUrl: config.discord.webhookUrl,
          fluxerWebhookUrl: config.fluxer.webhookUrl
        });
        // Also store reverse mapping for Fluxer→Discord
        mappings.set(matchingFluxerChan.id, {
          discordChannelId: discordChan.id,
          fluxerChannelId: matchingFluxerChan.id,
          discordWebhookUrl: config.discord.webhookUrl,
          fluxerWebhookUrl: config.fluxer.webhookUrl
        });
      }
    }
  } else if (config.channelMapping === 'by_position') {
    const discordGuild = await discordClient.guilds.fetch(config.discord.serverId);
    const fluxerChannels = await fluxerClient.getChannels(config.fluxer.guildId);

    const discordChannels = await discordGuild.channels.fetch();
    const textChannels = discordChannels.filter(c => c.type === 0 || c.type === 5)
      .sort((a, b) => a.rawPosition - b.rawPosition);

    fluxerChannels
      .filter(c => c.type === 0)
      .sort((a, b) => a.position - b.position)
      .forEach((fluxerChan, index) => {
        const discordChan = textChannels[index];
        if (discordChan) {
          mappings.set(discordChan.id, {
            discordChannelId: discordChan.id,
            fluxerChannelId: fluxerChan.id,
            discordWebhookUrl: config.discord.webhookUrl,
            fluxerWebhookUrl: config.fluxer.webhookUrl
          });
          mappings.set(fluxerChan.id, {
            discordChannelId: discordChan.id,
            fluxerChannelId: fluxerChan.id,
            discordWebhookUrl: config.discord.webhookUrl,
            fluxerWebhookUrl: config.fluxer.webhookUrl
          });
        }
      });
  }

  return mappings;
}

// ============ DISCORD → FLUXER RELAY ============

async function processDiscordMessageMedia(message) {
  const files = [];
  if (message.attachments?.size > 0) {
    for (const [, attachment] of message.attachments) {
      const res = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      files.push({
        buffer: res.data,
        filename: attachment.name,
        contentType: attachment.contentType || 'application/octet-stream'
      });
    }
  }
  return files;
}

async function relayDiscordToFluxer(message, mapping, fluxerClient, messageMaps) {
  const { discordToFluxer } = messageMaps;

  let replyToFluxerId = null;
  if (message.reference?.messageId) {
    replyToFluxerId = discordToFluxer.get(message.reference.messageId);
  }

  const files = await processDiscordMessageMedia(message);

  const payload = {
    content: message.content,
    username: message.author.displayName || message.author.username,
    avatar_url: message.author.displayAvatarURL({ dynamic: true, size: 4096 })
  };

  try {
    let fluxerMessageId = null;

    if (mapping.fluxerWebhookUrl && files.length === 0) {
      const res = await axios.post(mapping.fluxerWebhookUrl, payload);
      fluxerMessageId = res.data?.id;
      if (!fluxerMessageId) {
        fluxerMessageId = `fallback_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      }
    } else if (mapping.fluxerWebhookUrl) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      if (replyToFluxerId) form.append('message_reference', replyToFluxerId);
      files.forEach((f, i) => form.append(`files[${i}]`, f.buffer, {
        filename: f.filename, contentType: f.contentType
      }));
      const res = await axios.post(mapping.fluxerWebhookUrl, form, { headers: form.getHeaders() });
      fluxerMessageId = res.data?.id;
    } else {
      const sent = await fluxerClient.sendMessage(mapping.fluxerChannelId,
        `**${message.author.username}**: ${message.content}`,
        { message_reference: replyToFluxerId, files }
      );
      fluxerMessageId = sent.id;
    }

    if (fluxerMessageId) {
      discordToFluxer.set(message.id, fluxerMessageId);
    }

  } catch (error) {
    console.error('Discord → Fluxer relay failed:', error.message);
  }
}

// ============ FLUXER → DISCORD RELAY ============

async function relayFluxerToDiscord(message, mapping, webhookClient, messageMaps) {
  const { fluxerToDiscord } = messageMaps;

  // Check if this is a bot message (sent by bridge itself) - skip to avoid loops
  if (message.author?.bot) {
    return;
  }

  let replyToDiscordId = null;
  if (message.message_reference?.message_id) {
    replyToDiscordId = fluxerToDiscord.get(message.message_reference.message_id);
  }

  const payload = {
    content: message.content,
    username: message.author?.global_name || message.author?.username || 'Fluxer User',
    avatarURL: message.author?.avatar
      ? `https://fluxerusercontent.com/avatars/${message.author.id}/${message.author.avatar}.webp`
      : undefined,
    ...(replyToDiscordId && { reply: { messageReference: replyToDiscordId } })
  };

  try {
    const sentMessage = await webhookClient.send(payload);

    // Store mapping for reply threading
    if (sentMessage.id) {
      fluxerToDiscord.set(message.id, sentMessage.id);
    }

  } catch (error) {
    console.error('Fluxer → Discord relay failed:', error.message);
  }
}

// ============ BRIDGE MANAGER ============

class BridgeManager {
  constructor(config) {
    this.config = config;
    this.mappings = new Map();
    this.discordClient = null;
    this.fluxerClient = null;
    this.webhookClients = new Map(); // Discord webhook clients keyed by channel ID
  }

  async start() {
    // Initialize Discord client
    this.discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel]
    });

    // Set up Discord message handler
    this.discordClient.on('messageCreate', async (message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      const mapping = this.mappings.get(message.channel.id);
      if (mapping) {
        await relayDiscordToFluxer(message, mapping, this.fluxerClient, messageMaps);
      }
    });

    await this.discordClient.login(this.config.discord.token);

    // Initialize Fluxer client
    this.fluxerClient = new FluxerClient({
      token: this.config.fluxer.token,
      baseUrl: this.config.fluxer.apiUrl,
      websocketUrl: this.config.fluxer.gatewayUrl
    });

    // Set up Fluxer message handler
    this.fluxerClient.onMessage = async (event) => {
      // Handle MESSAGE_CREATE event (new message in Fluxer)
      if (event.t === 'MESSAGE_CREATE') {
        const message = event.d;
        const mapping = this.mappings.get(message.channel_id);

        if (mapping && mapping.discordWebhookUrl) {
          const webhookClient = this.webhookClients.get(mapping.discordChannelId) ||
            new WebhookClient({ url: mapping.discordWebhookUrl });
          this.webhookClients.set(mapping.discordChannelId, webhookClient);

          await relayFluxerToDiscord(message, mapping, webhookClient, messageMaps);
        }
      }
    };

    await this.fluxerClient.connect();

    // Build channel mappings after both clients are ready
    this.mappings = await buildGuildMappings(this.config, this.discordClient, this.fluxerClient);
    console.log(`[Bridge] ${this.mappings.size / 2} channel pairs mapped`);
  }

  stop() {
    if (this.discordClient) this.discordClient.destroy();
    if (this.fluxerClient?.ws) this.fluxerClient.ws.close();
  }
}

module.exports = {
  FluxerClient,
  BridgeManager,
  buildGuildMappings,
  relayDiscordToFluxer,
  relayFluxerToDiscord,
  messageMaps
};