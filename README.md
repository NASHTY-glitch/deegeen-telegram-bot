# Deegeen Telegram Guard Bot

Group moderation bot for **@Deegeen_bot** (Telegram). Welcomes new members,
posts the rules, deletes links and banned words from non-admins, warns
rule-breakers (3 warnings = removal), mutes flooders, and gives admins
/warn, /mute, /unmute, /kick and /ban commands.

## Run

```bash
npm start          # webhook mode; registers the webhook when PUBLIC_URL is set
npm test           # logic tests (fake Telegram API, in-memory DB)
LOCAL_POLL=1 npm start   # local development: long-polling instead of webhook
```

## Environment

| Variable         | Meaning                                                        |
|------------------|----------------------------------------------------------------|
| `BOT_TOKEN`      | Bot token from BotFather (required)                            |
| `PUBLIC_URL`     | Public https base URL of this service (webhook registration)   |
| `WEBHOOK_SECRET` | Optional shared secret checked on webhook calls                |
| `BOT_DATA_DIR`   | Where the sqlite state file lives (default `./data`)           |
| `PORT`           | Port to listen on (default 3000)                               |

## Setup in a group

1. Add @Deegeen_bot to the group.
2. Promote it to admin with **delete messages** and **ban users** rights.
3. Send /rules to see the rules, /help for all commands. Admins can change
   the rules with /setrules and manage banned words with /addword, /delword
   and /words.

Note: on hosts with an ephemeral disk (e.g. Render free tier) the warnings
database resets on restart/redeploy.
