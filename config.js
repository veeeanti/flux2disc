module.exports = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    serverId: process.env.DISCORD_SERVERID
  },
  fluxer: {
    token: process.env.FLUXER_TOKEN,
    guildId: process.env.FLUXER_GUILDID
  },
  channelMapping: process.env.MAPPING_TYPE
};
