import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fsociety-group-check-"));
const originalCwd = process.cwd();

global.channelInfo = {};
process.chdir(tempRoot);

function commandUrl(relativePath) {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

function createSocket({ metadata, participantResult } = {}) {
  const sent = [];
  const participantActions = [];
  const socket = {
    user: { id: "51900000000@s.whatsapp.net" },
    sent,
    participantActions,
    async sendMessage(jid, payload, options) {
      sent.push({ jid, payload, options });
      return { key: { id: `sent-${sent.length}` } };
    },
    async groupMetadata() {
      return (
        metadata || {
          id: "test@g.us",
          addressingMode: "lid",
          participants: [
            {
              id: "100000000000001@lid",
              phoneNumber: "51900000000@s.whatsapp.net",
              admin: "admin",
            },
            {
              id: "100000000000002@lid",
              phoneNumber: "51911111111@s.whatsapp.net",
              admin: null,
            },
          ],
        }
      );
    },
    async groupParticipantsUpdate(jid, participants, action) {
      participantActions.push({ jid, participants, action });
      if (participantResult) return participantResult(jid, participants, action);
      return participants.map((participant) => ({ jid: participant, status: "200" }));
    },
    async groupInviteCode() {
      throw new Error("A non-admin must not request the invite code.");
    },
    async profilePictureUrl() {
      throw new Error("No profile picture in test.");
    },
  };
  return socket;
}

async function testParticipantCompatibility() {
  const {
    findGroupParticipant,
    getParticipantMentionJid,
    runGroupParticipantAction,
  } = await import(commandUrl("lib/group-compat.js"));
  const sock = createSocket();
  const metadata = await sock.groupMetadata("test@g.us");
  const participant = findGroupParticipant(metadata, ["51911111111@s.whatsapp.net"]);

  assert.equal(participant?.id, "100000000000002@lid");
  assert.equal(
    getParticipantMentionJid(metadata, participant, "51911111111@s.whatsapp.net"),
    "100000000000002@lid"
  );

  const result = await runGroupParticipantAction(
    sock,
    "test@g.us",
    metadata,
    participant,
    ["51911111111@s.whatsapp.net"],
    "remove"
  );
  assert.equal(result.ok, true);
  assert.equal(result.jid, "100000000000002@lid");
}

async function testDelegatedPermissions() {
  const command = (await import(commandUrl("commands/grupos/comandosimagen.js"))).default;
  const sock = createSocket();
  const context = {
    sock,
    from: "test@g.us",
    msg: { key: { id: "permission-test" } },
    args: ["51911111111"],
    commandName: "addvip",
    isGroup: true,
    esGrupo: true,
    esAdmin: false,
    esOwner: false,
  };

  await command.run(context);
  assert.match(String(sock.sent.at(-1)?.payload?.text || ""), /Solo el owner/i);

  sock.sent.length = 0;
  await command.run({ ...context, commandName: "linkgp", args: [] });
  assert.match(String(sock.sent.at(-1)?.payload?.text || ""), /Solo los administradores/i);
}

async function testAntilinkWithoutProtocol() {
  const command = (await import(commandUrl("commands/grupos/antilink.js"))).default;
  const sock = createSocket();
  const from = "test@g.us";
  const settings = { prefix: ["."] };
  const commandMessage = {
    key: { id: "config", remoteJid: from, participant: "51900000000@s.whatsapp.net" },
    body: ".antilink on",
    text: ".antilink on",
  };

  await command.run({ sock, from, args: ["on"], msg: commandMessage, settings });
  sock.sent.length = 0;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const userMessage = {
      key: {
        id: `bare-link-${attempt}`,
        remoteJid: from,
        participant: "51911111111@s.whatsapp.net",
      },
      sender: "51911111111@s.whatsapp.net",
      message: { conversation: `visita example.com/oferta-${attempt}` },
    };
    await command.onMessage({
      sock,
      msg: userMessage,
      from,
      esGrupo: true,
      esAdmin: false,
      esOwner: false,
      esBotAdmin: true,
      groupMetadata: await sock.groupMetadata(from),
    });
  }

  assert.equal(
    sock.sent.filter((entry) => String(entry.payload?.delete?.id || "").startsWith("bare-link-")).length,
    3
  );
  assert.equal(
    sock.sent.some((entry) => /ANTILINK AVISO 1\/3/.test(String(entry.payload?.text || ""))),
    true
  );
  assert.equal(
    sock.sent.some((entry) => /Fue expulsado del grupo/.test(String(entry.payload?.text || ""))),
    true
  );
  assert.equal(
    sock.participantActions.some((entry) => entry.action === "remove"),
    true
  );
}

async function testWelcomeSkipsBot() {
  const command = (await import(commandUrl("commands/grupos/welcome.js"))).default;
  const sock = createSocket();
  const from = "test@g.us";
  await command.run({
    sock,
    from,
    args: ["on"],
    msg: { key: { id: "welcome-config" } },
    settings: { prefix: ["."] },
  });
  sock.sent.length = 0;

  await command.onGroupUpdate({
    sock,
    update: {
      id: from,
      action: "add",
      participants: ["100000000000001@lid"],
    },
    settings: { prefix: ["."], botName: "FSOCIETY" },
  });
  assert.equal(sock.sent.length, 0);
}

try {
  await testParticipantCompatibility();
  await testDelegatedPermissions();
  await testAntilinkWithoutProtocol();
  await testWelcomeSkipsBot();
  console.log("[groups] OK. Permisos, AntiLink, LID y eventos de grupo verificados.");
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
