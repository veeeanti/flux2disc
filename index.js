#!/usr/bin/env node

require('dotenv').config();

const { BridgeManager } = require('./flux2disc');
let config = require('./config');

function validateConfig() {
  const required = ['discord.token', 'discord.serverId', 'fluxer.token', 'fluxer.guildId'];
  for (const path of required) {
    const parts = path.split('.');
    let val = config;
    for (const p of parts) val = val?.[p];
    if (!val) {
      console.error(`[Flux2Disc Bridge] ERROR: Missing ${path} in config`);
      process.exit(1);
    }
  }
}

async function main() {
  validateConfig();
  
  console.log('[Flux2Disc Bridge] Starting bridge...');
  const bridge = new BridgeManager(config);

  try {
    await bridge.start();
    console.log('[Flux2Disc Bridge] Bridge is running!');
    console.log('Press Ctrl+C to stop.');
  } catch (error) {
    console.error('[Flux2Disc Bridge] Failed to start:', error.message);
    process.exit(1);
  }

  process.on('SIGINT', () => {
    console.log('\n[Flux2Disc Bridge] Shutting down...');
    bridge.stop();
    process.exit(0);
  });
}

main();
