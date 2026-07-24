const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://secure.xserver.ne.jp/xapanel/login/xvps/';
const VPS_INDEX_URL = 'https://secure.xserver.ne.jp/xapanel/xvps/index';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(DATA_DIR, 'profiles');
const RENEWAL_THRESHOLD_DAYS = Number(process.env.RENEWAL_THRESHOLD_DAYS || 1);
const HEADLESS = process.env.BROWSER_HEADLESS !== 'false';
const BROWSER_PROXY = process.env.CLOAKBROWSER_PROXY || process.env.BROWSER_PROXY_SERVER || '';
const BROWSER_GEOIP =
  process.env.BROWSER_GEOIP == null ? Boolean(BROWSER_PROXY) : process.env.BROWSER_GEOIP === 'true';
const BROWSER_TIMEZONE = process.env.BROWSER_TIMEZONE || 'Asia/Tokyo';
const BROWSER_LOCALE = process.env.BROWSER_LOCALE || 'ja-JP';
const CLEAR_PROFILE_CACHE = process.env.CLEAR_PROFILE_CACHE !== 'false';
const activeAccountChecks = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}

function fingerprintSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cleanupProfileCache(userDataDir) {
  if (!CLEAR_PROFILE_CACHE) return;

  const cachePaths = [
    path.join(userDataDir, 'Default', 'Cache'),
    path.join(userDataDir, 'Default', 'Code Cache'),
    path.join(userDataDir, 'Default', 'GPUCache'),
    path.join(userDataDir, 'Default', 'Service Worker', 'CacheStorage'),
    path.join(userDataDir, 'GrShaderCache'),
    path.join(userDataDir, 'ShaderCache'),
  ];

  for (const target of cachePaths) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (_) {
      // Cache cleanup is best-effort; cookies and local storage are left intact.
    }
  }
}

function parseExpiry(text) {
  const match = String(text || '').match(/(20\d{2})\s*(?:[-/年])\s*(\d{1,2})\s*(?:[-/月])\s*(\d{1,2})/);
  if (!match) {
    return {
      success: false,
      action: 'check',
      error: `无法解析到期日: ${text || '(empty)'}`,
    };
  }

  const expiryDate = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  const todayText = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' });
  const today = new Date(`${todayText}T00:00:00+09:00`);
  const expiry = new Date(`${expiryDate}T00:00:00+09:00`);
  const daysLeft = Math.ceil((expiry - today) / 86400000);

  return {
    success: true,
    action: 'check',
    expiryDate,
    daysLeft,
    needsRenewal: daysLeft <= RENEWAL_THRESHOLD_DAYS,
    message: `到期日 ${expiryDate}, 剩余 ${daysLeft} 天`,
  };
}

async function launchAccountContext(account) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const { launchPersistentContext } = await import('cloakbrowser');
  const userDataDir = path.join(PROFILE_DIR, `${account.id}-${safeName(account.username)}`);
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    `--lang=${BROWSER_LOCALE}`,
    `--fingerprint=${fingerprintSeed(account.username)}`,
  ];
  const options = {
    userDataDir,
    headless: HEADLESS,
    humanize: true,
    geoip: BROWSER_GEOIP,
    timezone: BROWSER_TIMEZONE,
    locale: BROWSER_LOCALE,
    viewport: { width: 1366, height: 900 },
    args,
  };

  if (BROWSER_PROXY) options.proxy = BROWSER_PROXY;

  const retryDelays = [0, 5000, 10000];
  let lastError;

  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    const delay = retryDelays[attempt];
    if (delay) await sleep(delay);
    try {
      return await launchPersistentContext(options);
    } catch (err) {
      lastError = err;
      if (!String(err.message || err).includes('Opening in existing browser session')) {
        throw err;
      }
      const nextDelay = retryDelays[attempt + 1];
      if (nextDelay != null) {
        console.warn(
          `[xserver] Profile is busy for account ${account.id}; retrying after ${nextDelay}ms`
        );
      }
    }
  }

  throw new Error(
    `账号 ${account.id} 的浏览器配置仍被占用，请稍后再试。原始错误: ${lastError.message}`
  );
}

async function clickFirst(page, selectors, timeout = 8000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      try {
        await locator.click({ timeout });
        return selector;
      } catch (_) {
        // Try the next candidate.
      }
    }
  }
  return null;
}

async function login(page, username, password) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const usernameInput = page.locator('#memberid, input[name="memberid"]').first();
  const passwordInput = page.locator('#user_password, input[name="user_password"]').first();
  await usernameInput.waitFor({ timeout: 30000 });
  await usernameInput.click({ timeout: 10000 });
  await usernameInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await usernameInput.type(username, { delay: 45 });
  await passwordInput.click({ timeout: 10000 });
  await passwordInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await passwordInput.type(password, { delay: 55 });

  const clicked = await clickFirst(page, [
    'input[name="action_user_login"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'text=ログイン',
    'text=ログインする',
  ]);

  if (!clicked) {
    throw new Error('找不到登录按钮');
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await sleep(4000);
}

async function isLoginPage(page) {
  if (page.url().includes('/login/')) return true;
  return (await page.locator('#memberid, input[name="memberid"]').count().catch(() => 0)) > 0;
}

async function hasFreeVpsRow(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('tr')].some((row) => {
      const text = row.textContent || '';
      return (
        row.querySelector('.freeServerIco') ||
        (text.includes('無料VPS') && row.querySelector('a[href*="/xapanel/xvps/server/detail"]')) ||
        row.querySelector('a[href^="/xapanel/xvps/server/detail?id="]')
      );
    });
  }).catch(() => false);
}

async function pageSummary(page) {
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').textContent({ timeout: 10000 }).catch(() => '');
  return {
    url: page.url(),
    title,
    bodyText: bodyText.slice(0, 300).replace(/\s+/g, ' '),
  };
}

async function ensureLoggedIn(page, account) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(VPS_INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);

    if (await hasFreeVpsRow(page)) return;

    if (await isLoginPage(page)) {
      await login(page, account.username, account.password);
      if (await hasFreeVpsRow(page)) return;

      await page.goto(VPS_INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
      if (await hasFreeVpsRow(page)) return;
    }

    await sleep(4000);
    if (await hasFreeVpsRow(page)) return;
  }

  const summary = await pageSummary(page);
  throw new Error(
    `XServer VPS page is not reachable after login. URL: ${summary.url}; title: ${summary.title}; snippet: ${summary.bodyText}`
  );

  await page.goto(VPS_INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);

  if (!page.url().includes('/login/')) return;

  await login(page, account.username, account.password);
  await page.goto(VPS_INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);

  if (page.url().includes('/login/')) {
    throw new Error('登录失败，账号密码可能错误，或需要人工验证');
  }
}

async function getFreeVpsInfo(page) {
  if (!(await hasFreeVpsRow(page))) {
    await page.goto(VPS_INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
  }

  let info = await extractFreeVpsFromPage(page);

  if (!info) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').textContent({ timeout: 10000 }).catch(() => '');
    return {
      success: false,
      action: 'check',
      error: `找不到免费 VPS。页面标题: ${title}; 片段: ${bodyText.slice(0, 240).replace(/\s+/g, ' ')}`,
    };
  }

  if ((!info.expiryText || !parseExpiry(info.expiryText).success) && info.detailHref) {
    const detailUrl = new URL(info.detailHref, VPS_INDEX_URL).href;
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    info = {
      ...info,
      ...(await extractFreeVpsDetailFromPage(page)),
    };
  }

  const parsed = parseExpiry(info.expiryText);
  return { ...parsed, detailHref: info.detailHref };
}

async function extractFreeVpsFromPage(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')];
    const row = rows.find((candidate) => {
      const text = candidate.textContent || '';
      return (
        candidate.querySelector('.freeServerIco') ||
        (text.includes('無料VPS') && candidate.querySelector('a[href*="/xapanel/xvps/server/detail"]')) ||
        candidate.querySelector('a[href^="/xapanel/xvps/server/detail?id="]')
      );
    });

    if (!row) return null;

    const detailHref =
      row.querySelector('a[href^="/xapanel/xvps/server/detail?id="]')?.getAttribute('href') ||
      row.querySelector('a[href*="/xapanel/xvps/server/detail"]')?.getAttribute('href') ||
      '';

    const explicitTerm = row.querySelector('.contract__term')?.textContent?.trim() || '';
    const dateMatches = (row.textContent || '').match(/20\d{2}\s*(?:[-/年])\s*\d{1,2}\s*(?:[-/月])\s*\d{1,2}/g) || [];

    return {
      expiryText: explicitTerm || dateMatches[dateMatches.length - 1] || '',
      detailHref,
    };
  }).catch(() => null);
}

async function extractFreeVpsDetailFromPage(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')];
    const limitRow = rows.find((row) => (row.textContent || '').includes('利用期限'));
    const expiryText =
      limitRow?.textContent?.match(/20\d{2}\s*(?:[-/年])\s*\d{1,2}\s*(?:[-/月])\s*\d{1,2}/)?.[0] ||
      '';

    return {
      expiryText,
      detailHref: location.href,
    };
  }).catch(() => ({ expiryText: '', detailHref: page.url() }));
}

async function checkAccountUnlocked(account) {
  let context;
  const userDataDir = path.join(PROFILE_DIR, `${account.id}-${safeName(account.username)}`);

  try {
    context = await launchAccountContext(account);
    const page = context.pages()[0] || await context.newPage();
    await ensureLoggedIn(page, account);
    const result = await getFreeVpsInfo(page);
    if (!result.success) return result;

    if (result.needsRenewal) {
      return {
        ...result,
        action: 'needs_renewal',
        message: `需要手动更新。到期日 ${result.expiryDate}, 剩余 ${result.daysLeft} 天`,
      };
    }

    return {
      ...result,
      action: 'check',
      message: `无需更新。到期日 ${result.expiryDate}, 剩余 ${result.daysLeft} 天`,
    };
  } catch (err) {
    return {
      success: false,
      action: 'check_failed',
      error: err.message,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
      cleanupProfileCache(userDataDir);
    }
  }
}

function checkAccount(account) {
  const key = `${account.id}-${safeName(account.username)}`;
  const existing = activeAccountChecks.get(key);
  if (existing) {
    console.log(`[xserver] Reusing active check for account ${account.id}`);
    return existing;
  }

  const check = checkAccountUnlocked(account).finally(() => {
    if (activeAccountChecks.get(key) === check) {
      activeAccountChecks.delete(key);
    }
  });
  activeAccountChecks.set(key, check);
  return check;
}

module.exports = {
  checkAccount,
  parseExpiry,
};
