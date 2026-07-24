# renewxserver3

Telegram bot for XServer free VPS multi-account monitoring and renewal reminders.

This version uses [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) instead of stock Playwright. Each XServer account gets its own persistent browser profile under `/data/profiles`, so cookies and browser identity can be reused across checks.

## Features

- Telegram bot account management
- Multiple XServer accounts
- Automatic XServer login and free VPS expiry detection
- Daily 06:00 Japan-time report showing every account's expiry date
- Daily 12:10 Japan-time recheck
- Urgent `❗ 需要及时更新` warning when an account has 0 days remaining
- Docker image ready for Zeabur deployment

## Telegram Commands

| Command | Description |
| --- | --- |
| `/start` | Show menu |
| `/add` | Add or update an XServer account |
| `/list` | List saved accounts |
| `/check` | Check all accounts |
| `/delete <id>` | Delete an account |
| `/help` | Show help |

## Schedule

Automatic jobs run in Japan time:

- `06:00`: check every account and send a complete expiry-date report.
- `12:10`: check every account again. Accounts with 0 days remaining are marked
  `❗ 需要及时更新`; if all accounts are healthy, this check stays silent.

## Zeabur Deployment

1. Push this repository to GitHub.
2. Create a Zeabur service from the GitHub repo.
3. Use Dockerfile deployment.
4. Add a persistent volume mounted at `/data`.
5. Add environment variables:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ADMIN_TELEGRAM_ID=your_numeric_telegram_user_id
DB_PATH=/data/accounts.db
DATA_DIR=/data
PROFILE_DIR=/data/profiles
CLOAKBROWSER_CACHE_DIR=/data/.cloakbrowser
BROWSER_HEADLESS=false
BROWSER_TIMEZONE=Asia/Tokyo
BROWSER_LOCALE=ja-JP
RENEWAL_THRESHOLD_DAYS=1
CHECK_LOG_RETENTION_DAYS=90
CHECK_LOG_MAX_ROWS=2000
CLEAR_PROFILE_CACHE=true
RUN_ON_START=false
```

Optional proxy for Zeabur or other datacenter hosting:

```env
CLOAKBROWSER_PROXY=http://user:pass@residential-proxy-host:port
BROWSER_GEOIP=true
```

`CLOAKBROWSER_PROXY` also accepts `socks5://user:pass@host:port`. This is optional for monitoring, but can help if XServer login or the control panel blocks datacenter IPs.

Optional CloakBrowser Pro:

```env
CLOAKBROWSER_LICENSE_KEY=cb_xxxxxxxx
```

The Docker image runs CloakBrowser in headed mode through Xvfb. The first run downloads the CloakBrowser Chromium binary into `CLOAKBROWSER_CACHE_DIR`. Keeping `/data` mounted avoids downloading it again after every redeploy.

## Disk Usage

Persistent data is stored under `/data`:

- `/data/accounts.db` stores accounts and recent check logs.
- `/data/profiles` stores one browser profile per XServer account so login cookies can be reused.
- `/data/.cloakbrowser` stores the CloakBrowser Chromium binary cache.

To avoid unbounded growth, check logs are pruned after each check. Defaults are `CHECK_LOG_RETENTION_DAYS=90` and `CHECK_LOG_MAX_ROWS=2000`. Browser cache folders inside each profile are also cleaned after checks by default with `CLEAR_PROFILE_CACHE=true`; cookies and local storage are kept.

## Local Development

```bash
npm install
npm run check
npm start
```

On Windows with very new Node versions, `sqlite3` may require Visual Studio C++ Build Tools. Zeabur builds inside Linux with the Dockerfile, which installs the required build tools.

## Notes

- Credentials are stored in SQLite at `/data/accounts.db`; keep the Zeabur volume private.
- If XServer changes its UI selectors or blocks detection, the bot sends a Telegram failure notification with the reason.
- Concurrent requests for the same account share one active browser check. A
  profile temporarily occupied by another service instance is retried before
  the bot reports an actionable error.
- This bot does not perform automatic renewal and does not submit XServer renewal forms.
