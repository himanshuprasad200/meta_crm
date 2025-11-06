require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const WebSocket = require('ws');
const cron = require('node-cron');
const { subscribePage } = require('./utils/meta');
const MetaPage = require('./models/MetaPage');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/leads', require('./routes/leads'));

mongoose.connect(process.env.MONGODB_URI);
console.log('MongoDB connected');

// === INITIALIZE WEBSOCKET CLIENTS MAP ===
global.clients = new Map();  // ADD THIS LINE

// WebSocket Server
const wss = new WebSocket.Server({ port: 8086 });
wss.on('connection', (ws, req) => {
  const userId = req.url.split('userId=')[1];
  if (!userId) {
    ws.close();
    return;
  }

  global.clients.set(userId, ws);
  console.log(`[WS] Connected: ${userId}`);

  ws.on('close', () => {
    global.clients.delete(userId);
    console.log(`[WS] Disconnected: ${userId}`);
  });
});

// Auto-subscribe on startup
setTimeout(async () => {
  try {
    const pages = await MetaPage.find({});
    for (const p of pages) {
      if (!p.webhook_subscribed) await subscribePage(p);
    }
    console.log(`[STARTUP] Auto-subscribed ${pages.length} pages`);
  } catch (err) {
    console.error('[STARTUP] Auto-subscribe failed:', err.message);
  }
}, 3000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close();
  mongoose.connection.close();
  process.exit(0);
});

app.listen(8085, () => {
  console.log('Server: http://localhost:8085');
  console.log('WebSocket: ws://localhost:8086');
});