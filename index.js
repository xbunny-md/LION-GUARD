import express from "express";
import { Server } from "socket.io";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import AdmZip from "adm-zip";
import makeWASocket, { 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion, 
  DisconnectReason 
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OWNER_NUMBER = process.env.OWNER_NUMBER;
const BOT_NAME = process.env.BOT_NAME || "LION GUARD";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Express server for Render + UptimeRobot
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.json({ status: "LION GUARD is alive", time: new Date().toISOString() });
});

app.get("/pair", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pair.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Supabase session save/load
const SESSION_FOLDER = path.join(__dirname, "session");
const SESSION_ID = "lion-guard-session";

async function saveSessionToSupabase() {
  if (!fs.existsSync(SESSION_FOLDER)) return;
  const zip = new AdmZip();
  zip.addLocalFolder(SESSION_FOLDER);
  const zipBuffer = zip.toBuffer().toString("base64");
  
  await supabase.from("bu_sessions").upsert({
    id: SESSION_ID,
    data: zipBuffer
  });
  console.log("Session saved to Supabase");
}

async function loadSessionFromSupabase() {
  const { data } = await supabase.from("bu_sessions").select("data").eq("id", SESSION_ID).single();
  if (!data) return;
  
  const zipBuffer = Buffer.from(data.data, "base64");
  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(SESSION_FOLDER, true);
  console.log("Session loaded from Supabase");
}

// Main bot start function
async function startBot() {
  if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER);
  await loadSessionFromSupabase();
  
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    fireInitQueries: false
  });

  sock.ev.on("creds.update", saveCreds);
  
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log("Scan QR code below:");
      io.emit("qr", qr);
    }
    
    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      
      if (lastDisconnect?.error?.message?.includes("conflict")) {
        console.log("Stream Errored conflict detected. Stopping to prevent duplicate sessions.");
        process.exit(1);
      }
      
      if (shouldReconnect) startBot();
    }
    
    if (connection === "open") {
      console.log("LION GUARD connected!");
      await sock.sendMessage(OWNER_NUMBER + "@s.whatsapp.net", { 
        text: `✅ ${BOT_NAME} is now online!` 
      });
    }
  });
  
  // Save session every 2 minutes to avoid rate limits
  setInterval(saveSessionToSupabase, 120000);
}

startBot();