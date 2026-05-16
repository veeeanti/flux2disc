#!/usr/bin/env node

// Fluxer-Discord Bridge - Main Entry Point
// A bidirectional bridge between Fluxer and Discord guilds

const { BridgeManager } = require('./fluxer-bridge-guildwide');
const config = require('./config');

async function main() {
  console.log('[Fluxer-Discord Bridge] Starting...');

  const bridge = new BridgeManager(config);

  try {
    await bridge.start();
    console.log('[Fluxer-Discord Bridge] Bridge is running!');
    console.log('Press Ctrl+C to stop.');
  } catch (error) {
    console.error('[Fluxer-Discord Bridge] Failed to start:', error.message);
    process.exit(1);
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Fluxer-Discord Bridge] Shutting down...');
    bridge.stop();
    process.exit(0);
  });
}

main();