// If preferred, you could just rename this to config.js and use a .env file instead
// for cases like Docker / Dokploy, which is what I'll be using, so both methods are supported. 
// Just make sure if you do, that you account for the fact it will need to be renamed!!

module.exports = {
  discord: {
    token: '' || 'process.env.DISCORD_TOKEN',
    serverId: '' || 'process.env.DISCORD_SERVERID'
  },
  fluxer: {
    token: '' || 'process.env.FLUXER_TOKEN',
    guildId: '' || 'process.env.FLUXER_GUILDID'
  },
  channelMapping: '' || 'process.env.MAPPING_TYPE'
};