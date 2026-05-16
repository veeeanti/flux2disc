// Fluxer-Discord Bridge Configuration Template
// Copy to config.js and fill in your values

module.exports = {
  // Discord Bot Configuration
  discord: {
    token: '',
    serverId: '',
    // Optional: specific webhook URL for name/avatar preservation
    // If not set, bridge uses bot token (no name/avatar override)
    webhookUrl: ''
  },

  // Fluxer Configuration
  fluxer: {
    token: '',
    guildId: '',
    // Fluxer API endpoint (default: https://api.fluxer.app)
    apiUrl: 'https://api.fluxer.app/v1',
    // Fluxer Gateway WebSocket endpoint
    gatewayUrl: 'wss://gateway.fluxer.app',
    // Optional: specific webhook URL for Fluxer
    webhookUrl: ''
  },

  // Channel mapping strategy
  // 'by_name' - match Discord channels to Fluxer channels by name
  // 'by_position' - match by channel position (fallback)
  channelMapping: 'by_name'
};