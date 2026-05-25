import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pino from 'pino'
import qrcode from 'qrcode'
import fs from 'fs'
import AdmZip from 'adm-zip'
import pkg from '@whiskeysockets/baileys'
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } = pkg
import { getBotSettings, listenSettingsUpdates, supabase } from './lib/supabase.js'
import { initializeRouter, handleMessages } from './lib/router.js'
import 'dotenv/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 1. GLOBAL STATE
let botSettings = null
let sock = null
let qrString = ''
let isConnected = false
let reconnectAttempts = 0
let lastCredsSync = 0 // Throttle Supabase writes
const MAX_RECONNECTS = 10
const SESSION_DIR = './session'

// 2. EXPRESS + SOCKET.IO
const app = express()
const server = createServer(app)
const io = new Server(server, { cors: { origin: "*" } })
const PORT = process.env.PORT || 3000

app.use(express.static(join(__dirname, 'public')))
app.use(express.json())

// Health endpoint kwa UptimeRobot - HAIJIPIGI PING
app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    bot: botSettings?.botname || 'BUNNY MD',
    connected: isConnected,
    uptime: Math.floor(process.uptime())
  })
})

// 3. SUPABASE SYNC - ZIP FOLDER YOTE, TUMIA bu_sessions
async function syncSessionToCloud(force = false) {
  try {
    // Throttle: Max mara 1 kila dakika 2, au force ukiconnect
    const now = Date.now()
    if (!force && now - lastCredsSync < 120000) return
    lastCredsSync = now

    if (!fs.existsSync(SESSION_DIR)) return

    // ZIP FOLDER YOTE YA SESSION
    const zip = new AdmZip()
    zip.addLocalFolder(SESSION_DIR)
    const zipBuffer = zip.toBuffer()
    const base64 = zipBuffer.toString('base64')

    await supabase.from('bu_sessions').upsert({
      id: 'full_session',
      data: base64,
      updated_at: new Date().toISOString()
    })
    console.log('☁️ Full session + keys synced to Supabase')
  } catch (e) {
    console.log('Session sync error:', e.message)
  }
}

async function loadSessionFromCloud() {
  try {
    const { data } = await supabase
      .from('bu_sessions')
      .select('data')
      .eq('id', 'full_session')
      .single()

    if (data?.data) {
      // FUTA YA ZAMANI KWANZA
      if (fs.existsSync(SESSION_DIR)) {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true })
      }
      fs.mkdirSync(SESSION_DIR, { recursive: true })

      // UNZIP KUTOKA SUPABASE
      const zipBuffer = Buffer.from(data.data, 'base64')
      const zip = new AdmZip(zipBuffer)
      zip.extractAllTo(SESSION_DIR, true)

      console.log('☁️ Full session + keys restored from Supabase')
      return true
    }
  } catch (e) {
    console.log('No session in Supabase')
  }
  return false
}

// 4. WHATSAPP CONNECTION - ANTI-SYNC, ANTI-BAD-MAC
async function connectToWhatsApp() {
  try {
    await loadSessionFromCloud()
    const { state, saveCreds } = await useMultiFileAuthState('./session')
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`)

    const hasSession = state.creds?.noiseKey ? true : false
    console.log(hasSession ? '🔄 Restoring session...' : '🔍 New session. QR will generate')

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      browser: Browsers.ubuntu('BUNNY MD'),
      // HIZI NDIO ZINAZUIA "SYNCING" NA "BAD MAC"
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldIgnoreJid: jid => jid === 'status@broadcast' || jid.endsWith('@newsletter'),
      fireInitQueries: false, // Inapunguza requests
      generateHighQualityLinkPreview: false, // Inapunguza RAM
      // Stable
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 20000,
      emitOwnEvents: true,
      retryRequestDelayMs: 500,
      maxMsgRetryCount: 2,
      getMessage: async () => ({ conversation: '' })
    })

    // 5. CONNECTION UPDATES
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr && !isConnected) {
        qrString = qr
        try {
          const qrImage = await qrcode.toDataURL(qr)
          io.emit('qr', qrImage)
          io.emit('status', 'Scan QR or use Pair Code')
          console.log('📱 QR ready at /pair.html')
        } catch (err) {
          console.log('QR generation failed:', err.message)
        }
      }

      if (connection === 'open') {
        isConnected = true
        qrString = ''
        reconnectAttempts = 0
        io.emit('status', 'Connected')
        console.log('✅ WhatsApp connected successfully!')

        // Pakua settings fresh kila ukiconnect
        botSettings = await getBotSettings()
        console.log('🔄 Fresh settings loaded. Prefix:', botSettings.prefix)

        await syncSessionToCloud(true) // FORCE SAVE MARA YA KWANZA
        await sendConfirmationMessage()
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        isConnected = false
        io.emit('status', 'Disconnected')
        console.log('Connection closed. Reason:', lastDisconnect?.error?.message)

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Logged out. Clearing session...')
          await supabase.from('bu_sessions').delete().eq('id', 'full_session')
          if (fs.existsSync('./session')) fs.rmSync('./session', { recursive: true, force: true })
          qrString = ''
          reconnectAttempts = 0
          setTimeout(() => connectToWhatsApp(), 5000)
        } else if (reconnectAttempts < MAX_RECONNECTS) {
          reconnectAttempts++
          const delay = Math.min(reconnectAttempts * 10000, 60000)
          console.log(`🔄 Reconnecting in ${delay/1000}s... Attempt ${reconnectAttempts}/${MAX_RECONNECTS}`)
          setTimeout(() => connectToWhatsApp(), delay)
        } else {
          console.log('⚠️ Max reconnects reached. Waiting 5 minutes...')
          reconnectAttempts = 0
          setTimeout(() => connectToWhatsApp(), 300000)
        }
      }
    })

    // 6. SAVE CREDS - THROTTLED
    sock.ev.on('creds.update', async () => {
      await saveCreds()
      syncSessionToCloud(false) // Ina throttle ndani
    })

    // 7. HANDLE MESSAGES
    sock.ev.on('messages.upsert', (m) => {
      handleMessages(sock, m, botSettings)
    })

  } catch (err) {
    console.error('Connection error:', err.message)
    if (reconnectAttempts < MAX_RECONNECTS) {
      reconnectAttempts++
      setTimeout(() => connectToWhatsApp(), 15000)
    }
  }
}

// 8. SOCKET.IO
io.on('connection', (socket) => {
  if (qrString && !isConnected) {
    qrcode.toDataURL(qrString).then(qrImage => {
      socket.emit('qr', qrImage)
    }).catch(() => {})
  }
  socket.emit('status', isConnected ? 'Connected' : 'Waiting for connection')

  socket.on('request_pair_code', async (phoneNumber) => {
    if (!sock || isConnected) return
    try {
      const code = await sock.requestPairingCode(phoneNumber)
      socket.emit('pair_code', code)
      console.log('Pair code sent:', code)
    } catch (err) {
      socket.emit('pair_error', 'Failed to generate code. Try QR.')
      console.log('Pair code error:', err.message)
    }
  })
})

// 9. CONFIRMATION - PUSHNAME FIXED
async function sendConfirmationMessage() {
  const s = botSettings
  const imageUrl = 'https://i.ibb.co/Mdg2Fkd/file-00000000f41871fdb744b8a6b7b612fa.png'
  const formatBool = (val) => val ? 'On' : 'Off'

  const botPushName = sock.user?.name || sock.user?.id?.split(':')[0] || 'User'

  const caption = `╭─⌈ *${s.botname}* ⌋
│
│ Hello ${botPushName}, bot is online.
│ Owner: ${s.owner_name}
│ Number: ${s.owner_number}
│ Prefix: ${s.prefix}
│
│ *SYSTEM STATUS*
│ Public Mode: On ✅
│ Anti-Link: ${formatBool(s.antilink)}
│ Anti-Spam: ${formatBool(s.antispam)}
│ Auto-Read: ${formatBool(s.autoread)}
│ Auto-Typing: ${formatBool(s.autotyping)}
│ View Status: ${formatBool(s.autoviewstatus)}
│
╰⊷ Type ${s.prefix}menu to start`

  try {
    await sock.sendMessage(`${s.owner_number}@s.whatsapp.net`, {
      image: { url: imageUrl },
      caption: caption
    })
    console.log('Confirmation sent to owner')
  } catch (err) {
    console.log('Failed to send confirmation:', err.message)
  }
}

// 10. MAIN START
async function startBot() {
  try {
    await initializeRouter()
    botSettings = await getBotSettings()
    if (!botSettings) {
      console.error('❌ Failed to load bot settings')
      process.exit(1)
    }
    console.log('✅ Settings loaded. Prefix:', botSettings.prefix)

    listenSettingsUpdates((newSettings) => {
      botSettings = newSettings
      console.log('🔥 Settings updated live. Prefix:', newSettings.prefix)
    })

    await connectToWhatsApp()

    server.listen(PORT, () => {
      console.log(`🐰 BUNNY MD running on port ${PORT}`)
    })

  } catch (err) {
    console.error('Bot failed to start:', err)
    process.exit(1)
  }
}

// 11. ANTI-CRASH
process.on('uncaughtException', (err) => console.error('Caught exception:', err.message))
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason))

startBot()