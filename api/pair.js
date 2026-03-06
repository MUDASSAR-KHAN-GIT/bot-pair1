// api/pair.js  —  Vercel Serverless Function
// Starts a Baileys connection, requests a pair code, waits for session, returns encoded session ID

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Vercel has /tmp for temp storage
const TMP = os.tmpdir();

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  let { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  phone = phone.replace(/[^0-9]/g, '');
  if (phone.length < 7) return res.status(400).json({ error: 'Invalid phone number' });

  const sessionDir = path.join(TMP, `session_${phone}_${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const logger = pino({ level: 'silent' });

  try {
    const { version }            = await fetchLatestBaileysVersion();
    const { state, saveCreds }   = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    // Request pair code
    await new Promise(r => setTimeout(r, 2000));
    const code = await sock.requestPairingCode(phone);

    // Wait for the session to be confirmed (up to 120 seconds)
    const sessionId = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sock.end();
        reject(new Error('Timed out waiting for WhatsApp confirmation. Please try again.'));
      }, 120_000);

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          clearTimeout(timeout);
          await saveCreds();

          // Read all session files and encode them as base64 JSON
          try {
            const files = {};
            const entries = fs.readdirSync(sessionDir);
            for (const f of entries) {
              const fp = path.join(sessionDir, f);
              if (fs.statSync(fp).isFile()) {
                files[f] = fs.readFileSync(fp, 'utf8');
              }
            }
            const encoded = Buffer.from(JSON.stringify(files)).toString('base64');
            sock.end();
            resolve(encoded);
          } catch (e) {
            sock.end();
            reject(e);
          }
        } else if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            clearTimeout(timeout);
            sock.end();
            reject(new Error('Session was rejected by WhatsApp.'));
          }
        }
      });
    });

    // Cleanup temp session dir
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}

    return res.status(200).json({
      success: true,
      pairCode: code,
      sessionId,
    });

  } catch (err) {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
    return res.status(500).json({ error: err.message || 'Failed to generate session' });
  }
};
