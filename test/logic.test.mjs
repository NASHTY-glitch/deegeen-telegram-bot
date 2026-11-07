// Logic tests for the Deegeen Telegram guard bot.
// Injects a recording fake Telegram API and an in-memory database, then
// feeds fake group updates and asserts on the actions the bot takes.
// Run: npm test

import { DatabaseSync } from 'node:sqlite';
import { createBot, containsLink, containsBadWord, FloodTracker } from '../server.mjs';

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
  if (!cond) failures++;
}

const CHAT = -1001;
const ADMIN = { id: 111, first_name: 'Boss', username: 'boss' };
const MEMBER = { id: 222, first_name: 'Tola', username: 'tola' };
const BOT = { id: 999, first_name: 'Deegeenbot', username: 'Deegeen_bot', is_bot: true };

const calls = [];
const fakeApi = async (method, params = {}) => {
  calls.push({ method, params });
  if (method === 'getMe') return BOT;
  if (method === 'getChatAdministrators') return [{ user: ADMIN }, { user: BOT }];
  return true;
};
const sent = () => calls.filter((c) => c.method === 'sendMessage');
const did = (method, pred = () => true) => calls.some((c) => c.method === method && pred(c.params));
const clear = () => { calls.length = 0; };

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE IF NOT EXISTS warns (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS chat_config (chat_id INTEGER PRIMARY KEY, rules TEXT, words TEXT NOT NULL DEFAULT '[]');`);
const bot = createBot({ api: fakeApi, db });

let mid = 0;
const msg = (from, text, extra = {}) => ({
  update_id: ++mid,
  message: { message_id: mid, chat: { id: CHAT, type: 'supergroup' }, from, text, ...extra },
});

console.log('— pure helpers —');
check('link in text detected', containsLink({ text: 'join us https://spam.example/x' }));
check('t.me link detected', containsLink({ text: 'see t.me/somechan' }));
check('url entity detected', containsLink({ text: 'click here', entities: [{ type: 'url', offset: 0, length: 5 }] }));
check('plain text has no link', !containsLink({ text: 'good morning everyone' }));
check('bad word matched case-insensitively', containsBadWord('This is a SCAM offer', ['scam']));
check('clean text passes word filter', !containsBadWord('hello friends', ['scam']));
const ft = new FloodTracker(3, 1000);
check('flood triggers after limit', [0, 100, 200, 300].map((t) => ft.feed('k', t)).at(-1) === true);

console.log('— welcome —');
clear();
await bot.processUpdate({ update_id: ++mid, message: { message_id: mid, chat: { id: CHAT, type: 'supergroup' }, from: MEMBER, new_chat_members: [MEMBER] } });
check('welcome + rules sent to new member', sent().some((c) => c.params.text.includes('Welcome') && c.params.text.includes('Group rules')));

console.log('— link enforcement —');
clear();
await bot.processUpdate(msg(MEMBER, 'free money https://spam.example'));
check('link message deleted', did('deleteMessage'));
check('warning 1/3 announced', sent().some((c) => c.params.text.includes('warning 1/3')));
clear();
await bot.processUpdate(msg(MEMBER, 'another www.spam.example link'));
check('warning 2/3 announced', sent().some((c) => c.params.text.includes('warning 2/3')));
clear();
await bot.processUpdate(msg(MEMBER, 'third strike t.me/spam'));
check('third warning kicks (ban + unban)', did('banChatMember') && did('unbanChatMember'));
check('removal announced', sent().some((c) => c.params.text.includes('was removed')));

console.log('— admins are exempt —');
clear();
await bot.processUpdate(msg(ADMIN, 'official link https://example.com/rules'));
check('admin link untouched', !did('deleteMessage') && sent().length === 0);

console.log('— commands —');
clear();
await bot.processUpdate(msg(MEMBER, '/rules'));
check('/rules replies with the rules', sent().some((c) => c.params.text.includes('Group rules')));
clear();
await bot.processUpdate(msg(MEMBER, '/warn', { reply_to_message: { from: ADMIN } }));
check('non-admin /warn refused', sent().some((c) => c.params.text.includes('Only group admins')));
clear();
await bot.processUpdate(msg(ADMIN, '/warn', { reply_to_message: { from: MEMBER } }));
check('admin /warn issues a warning', sent().some((c) => c.params.text.includes('warning 1/3')));
clear();
await bot.processUpdate(msg(ADMIN, '/addword rugpull'));
await bot.processUpdate(msg(MEMBER, 'check this rugpull now'));
check('banned word deleted + warned', did('deleteMessage') && sent().some((c) => c.params.text.includes('warning 2/3')));

console.log('— flood —');
clear();
for (let i = 0; i < 6; i++) await bot.processUpdate(msg(MEMBER, `spam burst ${i}`));
check('no mute before the limit', !did('restrictChatMember'));
await bot.processUpdate(msg(MEMBER, 'spam burst 7'));
check('flooder muted on 7th rapid message', did('restrictChatMember', (p) => p.user_id === MEMBER.id));

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
