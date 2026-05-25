export const name = "ping";
export const category = "Test";

export async function execute(sock, msg, args) {
  await sock.sendMessage(msg.key.remoteJid, { text: "Pong! 🏓 LION GUARD is working" });
}