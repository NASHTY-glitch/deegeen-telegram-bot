// Deegeen Telegram moderation bot (@Deegeen_bot).
//
// A group guard: welcomes new members, posts the rules, deletes links and
// banned words from non-admins, warns rule-breakers and kicks them after
// 3 warnings, and gives admins /warn /mute /kick /ban commands.
//
// Runtime: Node 24, no npm dependencies. State (warnings, per-group rules
// and word lists) lives in a node:sqlite database file.
// Config via env: BOT_TOKEN (required), PUBLIC_URL (the public https base
// URL of this service; when set, the bot registers a webhook on startup),
// WEBHOOK_SECRET (optional shared secret checked on webhook calls),
// BOT_DATA_DIR (default ./data), LOCAL_POLL=1 (long-poll instead of serving
// a webhook; local development only).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const TOKEN = process.env.BOT_TOKEN || '';
const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DATA_DIR = process.env.BOT_DATA_DIR || path.join(process.cwd(), 'data');
const PORT = Number(process.env.PORT || 3000);
const MAX_WARNS = 3;
const FLOOD_LIMIT = 6;          // messages ...
const FLOOD_WINDOW_MS = 10_000; // ... within 10 seconds ...
const FLOOD_MUTE_SECONDS = 600; // ... earns a 10 minute mute

export const DEFAULT_RULES = [
  'Group rules:',
  '1. No links or adverts without an admin\u2019s permission.',
  '2. No spam or flooding.',
  '3. Respect everyone \u2014 no insults or harassment.',
  '4. Stay on topic.',
  'Breaking the rules earns a warning; 3 warnings and you are removed.',
].join('\n');

const LINK_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|telegram\.dog\/)/i;

export function containsLink(message) {
  const text = message?.text || message?.caption || '';
  if (LINK_RE.test(text)) return true;
  const entities = message?.entities || message?.caption_entities || [];
  return entities.some((e) => e.type === 'url' || e.type === 'text_link');
}

export function containsBadWord(text, words) {
  if (!text || !words?.length) return false;
  const lower = ` ${text.toLowerCase()} `;
  return words.some((w) => w && lower.includes(w.toLowerCase()));
}

// Sliding-window flood tracker. feed() returns true when the sender has
// exceeded the limit inside the window (and clears their window, so one
// mute follows one burst).
export class FloodTracker {
  constructor(limit = FLOOD_LIMIT, windowMs = FLOOD_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  feed(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    if (arr.length > this.limit) {
      this.hits.delete(key);
      return true;
    }
    this.hits.set(key, arr);
    return false;
  }
}

// ---------- storage ----------
function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'bot.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS warns (
      chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS chat_config (
      chat_id INTEGER PRIMARY KEY, rules TEXT, words TEXT NOT NULL DEFAULT '[]'
    );
  `);
  return db;
}

// ---------- bot ----------
export function createBot({ api, db }) {
  const flood = new FloodTracker();
  const adminCache = new Map(); // chatId -> { at, ids:Set, botAdmin:bool }

  const getConfig = (chatId) => {
    const row = db.prepare('SELECT rules, words FROM chat_config WHERE chat_id = ?').get(chatId);
    return {
      rules: row?.rules || DEFAULT_RULES,
      words: row ? JSON.parse(row.words || '[]') : [],
    };
  };
  const saveConfig = (chatId, cfg) => {
    db.prepare('INSERT INTO chat_config (chat_id, rules, words) VALUES (?, ?, ?) ' +
      'ON CONFLICT(chat_id) DO UPDATE SET rules = excluded.rules, words = excluded.words')
      .run(chatId, cfg.rules, JSON.stringify(cfg.words));
  };
  const getWarns = (chatId, userId) =>
    db.prepare('SELECT count FROM warns WHERE chat_id = ? AND user_id = ?').get(chatId, userId)?.count || 0;
  const setWarns = (chatId, userId, n) => {
    if (n <= 0) db.prepare('DELETE FROM warns WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
    else db.prepare('INSERT INTO warns (chat_id, user_id, count) VALUES (?, ?, ?) ' +
      'ON CONFLICT(chat_id, user_id) DO UPDATE SET count = excluded.count').run(chatId, userId, n);
  };

  async function admins(chatId) {
    const hit = adminCache.get(chatId);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    let ids = new Set();
    let botAdmin = false;
    try {
      const me = await api('getMe');
      const list = await api('getChatAdministrators', { chat_id: chatId });
      ids = new Set((list || []).map((m) => m.user.id));
      botAdmin = ids.has(me.id);
    } catch { /* treat as no admins; bot will stay quiet on enforcement */ }
    const entry = { at: Date.now(), ids, botAdmin };
    adminCache.set(chatId, entry);
    return entry;
  }

  const say = (chatId, text, extra = {}) =>
    api('sendMessage', { chat_id: chatId, text, ...extra }).catch(() => null);
  const mention = (user) =>
    user.username ? `@${user.username}` : (user.first_name || 'member');

  async function addWarn(chatId, user, reason) {
    const n = getWarns(chatId, user.id) + 1;
    if (n >= MAX_WARNS) {
      setWarns(chatId, user.id, 0);
      try {
        await api('banChatMember', { chat_id: chatId, user_id: user.id });
        await api('unbanChatMember', { chat_id: chatId, user_id: user.id }); // kick, not a ban: they may rejoin later
        await say(chatId, `${mention(user)} was removed after ${MAX_WARNS} warnings (last: ${reason}).`);
      } catch {
        await say(chatId, `${mention(user)} reached ${MAX_WARNS} warnings but I could not remove them \u2014 make sure I am an admin with remove rights.`);
      }
      return;
    }
    setWarns(chatId, user.id, n);
    await say(chatId, `\u26a0\ufe0f ${mention(user)} \u2014 warning ${n}/${MAX_WARNS}: ${reason}.`);
  }

  async function handleMessage(msg) {
    const chat = msg.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      if (chat?.type === 'private' && msg.text?.startsWith('/start')) {
        await say(chat.id, 'Hi! I am a group guard bot. Add me to your group and promote me to admin, and I will keep it clean: no links or spam, warnings for rule-breakers, and /rules for everyone.');
      }
      return;
    }
    const chatId = chat.id;

    // New members -> welcome + rules.
    if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) {
      const cfg = getConfig(chatId);
      for (const member of msg.new_chat_members) {
        if (member.is_bot) continue;
        await say(chatId, `Welcome, ${mention(member)}! \ud83d\udc4b\n\n${cfg.rules}`);
      }
      return;
    }

    const from = msg.from;
    if (!from || from.is_bot) return;
    const text = msg.text || msg.caption || '';
    const { ids: adminIds, botAdmin } = await admins(chatId);
    const isAdmin = adminIds.has(from.id);

    // ----- commands -----
    if (text.startsWith('/')) {
      const [rawCmd, ...rest] = text.split(/\s+/);
      const cmd = rawCmd.split('@')[0].toLowerCase();
      const argText = rest.join(' ').trim();
      if (cmd === '/rules') { await say(chatId, getConfig(chatId).rules); return; }
      if (cmd === '/help') {
        await say(chatId, 'Everyone: /rules\nAdmins: /warn, /mute <minutes>, /unmute, /kick, /ban (reply to a message or add @username), /setrules <text>, /addword <word>, /delword <word>, /words');
        return;
      }
      if (!isAdmin) {
        if (['/warn', '/mute', '/unmute', '/kick', '/ban', '/setrules', '/addword', '/delword'].includes(cmd)) {
          await say(chatId, 'Only group admins can use that command.');
        }
        return;
      }
      // Admin commands.
      const target = msg.reply_to_message?.from ||
        (argText.startsWith('@')
          ? { id: null, username: argText.slice(1).split(/\s+/)[0] }
          : null);
      const needTarget = ['/warn', '/mute', '/unmute', '/kick', '/ban'];
      if (needTarget.includes(cmd)) {
        if (!target?.id) {
          await say(chatId, `Reply to one of their messages with ${cmd} so I know who you mean.`);
          return;
        }
        if (cmd === '/warn') await addWarn(chatId, target, 'warned by an admin');
        if (cmd === '/kick') {
          await api('banChatMember', { chat_id: chatId, user_id: target.id }).catch(() => {});
          await api('unbanChatMember', { chat_id: chatId, user_id: target.id }).catch(() => {});
          await say(chatId, `${mention(target)} was removed by an admin.`);
        }
        if (cmd === '/ban') {
          await api('banChatMember', { chat_id: chatId, user_id: target.id }).catch(() => {});
          await say(chatId, `${mention(target)} was banned by an admin.`);
        }
        if (cmd === '/mute') {
          const minutes = Math.max(1, parseInt(rest.find((a) => /^\d+$/.test(a)) || '10', 10) || 10);
          await api('restrictChatMember', {
            chat_id: chatId, user_id: target.id,
            until_date: Math.floor(Date.now() / 1000) + minutes * 60,
            permissions: { can_send_messages: false },
          }).catch(() => {});
          await say(chatId, `${mention(target)} was muted for ${minutes} minutes by an admin.`);
        }
        if (cmd === '/unmute') {
          await api('restrictChatMember', {
            chat_id: chatId, user_id: target.id,
            permissions: {
              can_send_messages: true, can_send_audios: true, can_send_documents: true,
              can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
              can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
              can_add_web_page_previews: true,
            },
          }).catch(() => {});
          await say(chatId, `${mention(target)} was unmuted.`);
        }
        return;
      }
      if (cmd === '/setrules') {
        if (!argText) { await say(chatId, 'Usage: /setrules followed by the rules text.'); return; }
        const cfg = getConfig(chatId);
        cfg.rules = argText;
        saveConfig(chatId, cfg);
        await say(chatId, 'Rules updated. Send /rules to see them.');
        return;
      }
      if (cmd === '/addword' || cmd === '/delword') {
        const word = argText.toLowerCase();
        if (!word) { await say(chatId, `Usage: ${cmd} <word or phrase>`); return; }
        const cfg = getConfig(chatId);
        if (cmd === '/addword' && !cfg.words.includes(word)) cfg.words.push(word);
        if (cmd === '/delword') cfg.words = cfg.words.filter((w) => w !== word);
        saveConfig(chatId, cfg);
        await say(chatId, `Banned words now: ${cfg.words.length ? cfg.words.join(', ') : '(none)'}`);
        return;
      }
      if (cmd === '/words') {
        const cfg = getConfig(chatId);
        await say(chatId, `Banned words: ${cfg.words.length ? cfg.words.join(', ') : '(none)'}`);
        return;
      }
      return;
    }

    // ----- automatic moderation (non-admins only) -----
    if (isAdmin || !botAdmin) return;
    const cfg = getConfig(chatId);

    if (containsLink(msg)) {
      await api('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      await addWarn(chatId, from, 'links are not allowed');
      return;
    }
    if (containsBadWord(text, cfg.words)) {
      await api('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      await addWarn(chatId, from, 'that word/phrase is not allowed here');
      return;
    }
    if (flood.feed(`${chatId}:${from.id}`)) {
      await api('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      await api('restrictChatMember', {
        chat_id: chatId, user_id: from.id,
        until_date: Math.floor(Date.now() / 1000) + FLOOD_MUTE_SECONDS,
        permissions: { can_send_messages: false },
      }).catch(() => {});
      await say(chatId, `\ud83e\udd10 ${mention(from)} was muted for 10 minutes for flooding the group.`);
    }
  }

  async function processUpdate(update) {
    try {
      if (update.message) await handleMessage(update.message);
      if (update.my_chat_member) {
        const chat = update.my_chat_member.chat;
        const status = update.my_chat_member.new_chat_member?.status;
        if (chat && (status === 'member' || status === 'administrator')) {
          await say(chat.id, 'I am on guard duty. Promote me to admin (with delete + remove rights) and I will enforce the rules. Send /rules to see them, /help for commands.');
        }
      }
    } catch (err) {
      console.error('update failed:', err?.message || err);
    }
  }

  return { processUpdate };
}

// ---------- telegram api ----------
function makeApi(token) {
  return async (method, params = {}) => {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) throw new Error(`${method}: ${data?.description || `HTTP ${res.status}`}`);
    return data.result;
  };
}

const COMMANDS = [
  { command: 'rules', description: 'Show the group rules' },
  { command: 'help', description: 'List bot commands' },
  { command: 'warn', description: 'Admin: warn a member (reply to their message)' },
  { command: 'mute', description: 'Admin: mute a member for N minutes' },
  { command: 'unmute', description: 'Admin: unmute a member' },
  { command: 'kick', description: 'Admin: remove a member (can rejoin)' },
  { command: 'ban', description: 'Admin: ban a member' },
];

// ---------- main ----------
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (!TOKEN) {
    console.error('BOT_TOKEN is not set');
    process.exit(1);
  }
  const api = makeApi(TOKEN);
  const bot = createBot({ api, db: openDb() });

  await api('setMyCommands', { commands: COMMANDS }).catch((e) => console.error('setMyCommands:', e.message));

  if (process.env.LOCAL_POLL === '1') {
    await api('deleteWebhook', {}).catch(() => {});
    console.log('Polling for updates (LOCAL_POLL)...');
    let offset = 0;
    for (;;) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'my_chat_member'] });
        for (const u of updates) { offset = u.update_id + 1; await bot.processUpdate(u); }
      } catch (err) {
        console.error('poll error:', err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } else {
    if (PUBLIC_URL) {
      await api('setWebhook', {
        url: `${PUBLIC_URL}/telegram`,
        secret_token: WEBHOOK_SECRET || undefined,
        allowed_updates: ['message', 'my_chat_member'],
        drop_pending_updates: true,
      }).then(() => console.log(`Webhook set to ${PUBLIC_URL}/telegram`))
        .catch((e) => console.error('setWebhook:', e.message));
    }
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Deegeen Telegram guard bot is running.');
        return;
      }
      if (req.method === 'POST' && req.url === '/telegram') {
        if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
          res.writeHead(401); res.end(); return;
        }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
        req.on('end', () => {
          res.writeHead(200); res.end('ok');
          try { bot.processUpdate(JSON.parse(body)); } catch { /* ignore malformed */ }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(PORT, () => console.log(`Guard bot listening on :${PORT}`));
  }
}
