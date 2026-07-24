const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot =
  TelegramBotModule.default || TelegramBotModule.TelegramBot || TelegramBotModule;
const {
  addAccount,
  getAccounts,
  deleteAccount,
  logCheck,
} = require('./db');
const { checkAccount } = require('./xserver');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
const RUN_ON_START = process.env.RUN_ON_START === 'true';

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error('ADMIN_TELEGRAM_ID is required');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const pendingActions = new Map();
let autoJobRunning = false;

function isAdmin(chatId) {
  return Number(chatId) === ADMIN_ID;
}

function requireAdmin(msg) {
  if (isAdmin(msg.chat.id)) return true;
  bot.sendMessage(msg.chat.id, '只有管理员可以使用这个机器人。');
  return false;
}

function menu() {
  return {
    keyboard: [
      ['账号列表', '添加账号'],
      ['立即检测', '删除账号'],
      ['帮助'],
    ],
    resize_keyboard: true,
  };
}

function escapeMarkdown(text) {
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function formatResult(account, result) {
  const name = escapeMarkdown(account.username);
  if (result.success) {
    if (result.daysLeft <= 0) {
      return `❗ *${name}*\n需要及时更新\n有效期: ${escapeMarkdown(result.expiryDate)}\n剩余: ${result.daysLeft} 天`;
    }

    return `✅ *${name}*\n有效期: ${escapeMarkdown(result.expiryDate)}\n剩余: ${result.daysLeft} 天`;
  }

  return `❌ *${name}*\n${escapeMarkdown(result.error || result.message || '检测失败')}`;
}

async function runAccount(account, { notifyFailure = false } = {}) {
  const result = await checkAccount(account);
  await logCheck(ADMIN_ID, account, result);

  if (notifyFailure && !result.success) {
    await bot.sendMessage(
      ADMIN_ID,
      `❌ 自动检测失败\n\n账号: ${account.username}\n原因: ${result.error || result.message || '未知错误'}`,
      { disable_web_page_preview: true }
    );
  }

  if (notifyFailure && result.success && result.daysLeft <= 0) {
    await bot.sendMessage(
      ADMIN_ID,
      `❗ 需要及时更新\n\n账号: ${account.username}\n有效期: ${result.expiryDate}\n剩余: ${result.daysLeft} 天`
    );
  }

  return result;
}

async function checkAll({ notifyFailure = false } = {}) {
  const accounts = await getAccounts(ADMIN_ID);
  if (!accounts.length) return [];

  const results = [];
  for (const account of accounts) {
    const result = await runAccount(account, { notifyFailure });
    results.push({ account, result });
  }
  return results;
}

function shouldNotifyResult(result) {
  return !result.success || result.daysLeft <= 0;
}

function nextJapanSlot(from = new Date()) {
  const jstParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(from).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const year = Number(jstParts.year);
  const month = Number(jstParts.month);
  const day = Number(jstParts.day);
  const hour = Number(jstParts.hour) === 24 ? 0 : Number(jstParts.hour);
  const minute = Number(jstParts.minute);
  const second = Number(jstParts.second);
  const slots = [
    { hour: 6, minute: 0, type: 'morning' },
    { hour: 12, minute: 10, type: 'noon' },
  ];
  const currentSeconds = hour * 3600 + minute * 60 + second;
  const nextSlot = slots.find((slot) => slot.hour * 3600 + slot.minute * 60 > currentSeconds);
  const target = nextSlot || slots[0];
  const targetJstMs = Date.UTC(
    year,
    month - 1,
    day + (nextSlot ? 0 : 1),
    target.hour,
    target.minute,
    0
  );

  // Convert the wall-clock JST target to UTC by subtracting 9 hours.
  return {
    time: new Date(targetJstMs - 9 * 3600 * 1000),
    type: target.type,
  };
}

function scheduleNextAutoCheck() {
  const next = nextJapanSlot();
  const delay = Math.max(1000, next.time.getTime() - Date.now());
  console.log(`Next auto check: ${next.time.toISOString()} (JST: 06:00 and 12:10)`);

  setTimeout(async () => {
    try {
      if (autoJobRunning) return;
      autoJobRunning = true;
      const results = await checkAll({ notifyFailure: false });
      const report =
        next.type === 'morning'
          ? results
          : results.filter(({ result }) => shouldNotifyResult(result));
      if (report.length) {
        const title =
          next.type === 'morning'
            ? '早上 6:00 全部账号有效期'
            : '中午 12:10 更新提醒';
        const lines = report.map(({ account, result }) => formatResult(account, result));
        await bot.sendMessage(ADMIN_ID, `${title}\n\n${lines.join('\n\n')}`, {
          parse_mode: 'MarkdownV2',
        });
      }
    } catch (err) {
      await bot.sendMessage(ADMIN_ID, `❌ 自动检测任务异常: ${err.message}`);
    } finally {
      autoJobRunning = false;
      scheduleNextAutoCheck();
    }
  }, delay);
}

bot.onText(/\/start/, (msg) => {
  if (!requireAdmin(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      '*renewxserver3*',
      '',
      'XServer 免费 VPS 到期监测和提醒机器人。',
      '每天日本时间 06:00 检测并显示所有账号有效期。',
      '每天 12:10 再检测一次，剩余 0 天时显示 ❗并提醒及时更新。',
      '',
      '/add 添加账号',
      '/list 查看账号',
      '/check 立即检测',
      '/delete <id> 删除账号',
    ].join('\n'),
    { parse_mode: 'Markdown', reply_markup: menu() }
  );
});

bot.onText(/\/help/, (msg) => {
  if (!requireAdmin(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    '命令：/add、/list、/check、/delete <id>。自动任务在日本时间 06:00 汇报全部账号有效期，并在 12:10 复查剩余 0 天的账号。',
    { reply_markup: menu() }
  );
});

bot.onText(/\/add/, (msg) => {
  if (!requireAdmin(msg)) return;
  pendingActions.set(msg.chat.id, { action: 'waiting_username' });
  bot.sendMessage(msg.chat.id, '请输入 XServer 登录账号：', { reply_markup: { force_reply: true } });
});

async function sendAccountList(chatId) {
  const accounts = await getAccounts(ADMIN_ID);
  if (!accounts.length) {
    return bot.sendMessage(chatId, '还没有账号。使用 /add 添加。', { reply_markup: menu() });
  }

  const text = accounts
    .map((account) => `ID ${account.id}: ${account.username}\n添加时间: ${account.created_at}`)
    .join('\n\n');
  return bot.sendMessage(chatId, text, { reply_markup: menu() });
}

bot.onText(/\/list/, async (msg) => {
  if (!requireAdmin(msg)) return;
  return sendAccountList(msg.chat.id);
});

bot.onText(/\/delete\s+(\d+)/, async (msg, match) => {
  if (!requireAdmin(msg)) return;
  const result = await deleteAccount(ADMIN_ID, Number(match[1]));
  bot.sendMessage(msg.chat.id, result.changes ? '账号已删除。' : '没有找到这个账号。', { reply_markup: menu() });
});

bot.onText(/\/check$/, async (msg) => {
  if (!requireAdmin(msg)) return;
  const sent = await bot.sendMessage(msg.chat.id, '正在检测所有账号...');
  try {
    const results = await checkAll({ notifyFailure: false });
    const text = results.length
      ? results.map(({ account, result }) => formatResult(account, result)).join('\n\n')
      : '还没有账号。使用 /add 添加。';
    await bot.editMessageText(text, {
      chat_id: msg.chat.id,
      message_id: sent.message_id,
      parse_mode: 'MarkdownV2',
    });
  } catch (err) {
    await bot.editMessageText(`检测失败: ${err.message}`, {
      chat_id: msg.chat.id,
      message_id: sent.message_id,
    });
  }
});

bot.on('message', async (msg) => {
  if (!isAdmin(msg.chat.id) || !msg.text || msg.text.startsWith('/')) return;

  const text = msg.text.trim();
  if (text === '账号列表') return sendAccountList(msg.chat.id);
  if (text === '添加账号') {
    pendingActions.set(msg.chat.id, { action: 'waiting_username' });
    return bot.sendMessage(msg.chat.id, '请输入 XServer 登录账号：', { reply_markup: { force_reply: true } });
  }
  if (text === '立即检测') {
    const sent = await bot.sendMessage(msg.chat.id, '正在检测所有账号...');
    try {
      const results = await checkAll({ notifyFailure: false });
      const reply = results.length
        ? results.map(({ account, result }) => formatResult(account, result)).join('\n\n')
        : '还没有账号。使用 /add 添加。';
      return bot.editMessageText(reply, {
        chat_id: msg.chat.id,
        message_id: sent.message_id,
        parse_mode: 'MarkdownV2',
      });
    } catch (err) {
      return bot.editMessageText(`检测失败: ${err.message}`, {
        chat_id: msg.chat.id,
        message_id: sent.message_id,
      });
    }
  }
  if (text === '帮助') {
    return bot.sendMessage(
      msg.chat.id,
      '命令：/add、/list、/check、/delete <id>。自动任务在日本时间 06:00 汇报全部账号有效期，并在 12:10 复查剩余 0 天的账号。',
      { reply_markup: menu() }
    );
  }

  if (text === '删除账号') {
    const accounts = await getAccounts(ADMIN_ID);
    if (!accounts.length) return bot.sendMessage(msg.chat.id, '还没有账号。', { reply_markup: menu() });
    pendingActions.set(msg.chat.id, { action: 'waiting_delete_id' });
    return bot.sendMessage(
      msg.chat.id,
      `请输入要删除的账号 ID：\n\n${accounts.map((a) => `${a.id}: ${a.username}`).join('\n')}`,
      { reply_markup: { force_reply: true } }
    );
  }

  const state = pendingActions.get(msg.chat.id);
  if (!state) return;

  if (state.action === 'waiting_username') {
    state.username = text;
    state.action = 'waiting_password';
    return bot.sendMessage(msg.chat.id, '请输入 XServer 登录密码：', { reply_markup: { force_reply: true } });
  }

  if (state.action === 'waiting_password') {
    pendingActions.delete(msg.chat.id);
    await addAccount(ADMIN_ID, state.username, text);
    return bot.sendMessage(msg.chat.id, `账号已保存: ${state.username}`, { reply_markup: menu() });
  }

  if (state.action === 'waiting_delete_id') {
    pendingActions.delete(msg.chat.id);
    const id = Number(text);
    if (!Number.isInteger(id)) return bot.sendMessage(msg.chat.id, '请输入数字 ID。', { reply_markup: menu() });
    const result = await deleteAccount(ADMIN_ID, id);
    return bot.sendMessage(msg.chat.id, result.changes ? '账号已删除。' : '没有找到这个账号。', { reply_markup: menu() });
  }
});

bot.on('polling_error', (err) => {
  console.error('Telegram polling error:', err.message);
});

scheduleNextAutoCheck();

if (RUN_ON_START) {
  setTimeout(() => {
    checkAll({ notifyFailure: true }).catch((err) => {
      console.error('Startup check failed:', err);
    });
  }, 15000);
}

console.log('renewxserver3 bot started');
