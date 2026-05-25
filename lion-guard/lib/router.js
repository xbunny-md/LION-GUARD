import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands = new Map();
const observers = [];

export async function loadCommands() {
  const commandsPath = path.join(__dirname, "../commands");
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"));

  for (const file of commandFiles) {
    try {
      const filePath = path.join(commandsPath, file);
      const fileURL = pathToFileURL(filePath).href;
      const command = await import(fileURL);

      if (commands.has(command.name)) {
        console.log(`⚠️ Duplicate command skipped: ${command.name}`);
        continue;
      }

      commands.set(command.name, command);
      console.log(`✅ Loaded: ${command.name} [${command.category || "Misc"}]`);
    } catch (err) {
      console.log(`❌ FAILED ${file}: ${err.message}`);
    }
  }
}

export async function loadObservers() {
  const obsPath = path.join(__dirname, "../observers");
  if (!fs.existsSync(obsPath)) return;

  const obsFiles = fs.readdirSync(obsPath).filter(file => file.endsWith(".js"));
  for (const file of obsFiles) {
    const fileURL = pathToFileURL(path.join(obsPath, file)).href;
    const obs = await import(fileURL);
    observers.push(obs);
  }
}

export function getAllCommands() {
  return Array.from(commands.values());
}

export async function handleMessage(sock, msg) {
  const prefix = process.env.PREFIX || "#";
  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

  if (!body.startsWith(prefix)) return;

  const args = body.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  const command = commands.get(commandName);
  if (!command) return;

  try {
    // Admin check example
    const groupMetadata = msg.key.remoteJid.endsWith("@g.us") 
      ? await sock.groupMetadata(msg.key.remoteJid) 
      : null;

    const isAdmin = groupMetadata 
      ? groupMetadata.participants.find(p => p.id === msg.key.participant)?.admin !== null
      : false;

    const isBotAdmin = groupMetadata
      ? groupMetadata.participants.find(p => p.id === sock.user.id.split(":")[0] + "@s.whatsapp.net")?.admin !== null
      : false;

    await command.execute(sock, msg, args, { isAdmin, isBotAdmin, groupMetadata });
  } catch (err) {
    console.log(`❌ Command error in ${commandName}:`, err);
    await sock.sendMessage(msg.key.remoteJid, { text: "Error running command." });
  }
}

export async function runObservers(sock, msg) {
  for (const obs of observers) {
    try {
      await obs.execute(sock, msg);
    } catch (err) {
      console.log("Observer error:", err);
    }
  }
}