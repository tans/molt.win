#!/usr/bin/env node

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

const usage = () => {
  console.log([
    'Usage: node scripts/report-referrals.mjs [options]',
    '',
    'Options:',
    '  --kv-base=<url>      KV base URL (default: https://kv.minapp.xin)',
    '  --prefix=<name>      KV prefix (default: xiake)',
    '  --phones=<csv>       Extra phones to include, comma-separated',
    '  --json               Print JSON report',
    '  -h, --help           Show help',
    '',
    'Examples:',
    '  node scripts/report-referrals.mjs',
    '  node scripts/report-referrals.mjs --json',
    '  node scripts/report-referrals.mjs --phones=13800138000,13900139000',
  ].join('\n'));
};

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}

if (typeof fetch !== 'function') {
  console.error('This script requires Node.js 18+ (global fetch is not available).');
  process.exit(1);
}

const options = {
  kvBase: 'https://kv.minapp.xin',
  prefix: 'xiake',
  phones: [],
  json: false,
};

for (const arg of args) {
  if (arg === '--json') {
    options.json = true;
    continue;
  }
  if (!arg.startsWith('--')) {
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }
  const [key, value = ''] = arg.slice(2).split('=');
  if (key === 'kv-base') {
    options.kvBase = value || options.kvBase;
  } else if (key === 'prefix') {
    options.prefix = value || options.prefix;
  } else if (key === 'phones') {
    options.phones = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  } else {
    console.error(`Unknown option: --${key}`);
    usage();
    process.exit(1);
  }
}

options.kvBase = options.kvBase.replace(/\/$/, '');

const kvKeyUser = (phone) => `${options.prefix}:ref:user:${phone}`;
const kvKeyOrders = (refCode) => `${options.prefix}:ref:orders:${refCode}`;
const kvKeySettles = (phone) => `${options.prefix}:ref:settles:${phone}`;
const kvKeyUsersIndex = () => `${options.prefix}:ref:users`;

const kvUrl = (key) => `${options.kvBase}/kv/${encodeURIComponent(key)}`;

const parseTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const formatTime = (value) => {
  const ts = parseTimestamp(value);
  if (!ts) {
    return '-';
  }
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
};

const formatFen = (fen) => `¥${((Number(fen) || 0) / 100).toFixed(0)}`;

const levelLabel = (level) => (level === 'pro' ? '高级用户' : '普通用户');

const rebateByLevel = (level) => (level === 'pro' ? 22000 : 2000);

const kvGetText = async (key) => {
  const response = await fetch(kvUrl(key));
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`KV GET failed (${response.status}) for key ${key}`);
  }
  return (await response.text()).trim();
};

const kvGetJson = async (key) => {
  const raw = await kvGetText(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseLineJsonList = (raw) => {
  if (!raw) {
    return [];
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const getLatestByOrderNo = (orders) => {
  const map = new Map();
  for (const order of orders) {
    const outTradeNo = String(order?.outTradeNo || '').trim();
    if (!outTradeNo) {
      continue;
    }
    const prev = map.get(outTradeNo);
    const prevTs = parseTimestamp(prev?.createdAt) || 0;
    const nowTs = parseTimestamp(order.createdAt) || 0;
    if (!prev || nowTs >= prevTs) {
      map.set(outTradeNo, order);
    }
  }
  return Array.from(map.values()).sort((a, b) => (parseTimestamp(b.createdAt) || 0) - (parseTimestamp(a.createdAt) || 0));
};

const buildSettlementStateMap = (settlements) => {
  const sorted = [...settlements].sort((a, b) => (parseTimestamp(b.createdAt) || 0) - (parseTimestamp(a.createdAt) || 0));
  const map = new Map();
  for (const settle of sorted) {
    if (!Array.isArray(settle.orderNos)) {
      continue;
    }
    for (const orderNo of settle.orderNos) {
      if (!map.has(orderNo)) {
        map.set(orderNo, settle.status || 'pending');
      }
    }
  }
  return map;
};

const loadIndexedUsers = async () => {
  const raw = await kvGetText(kvKeyUsersIndex());
  const rows = parseLineJsonList(raw);
  const latestByPhone = new Map();
  for (const row of rows) {
    const phone = String(row?.phone || '').trim();
    if (!phone) {
      continue;
    }
    const prev = latestByPhone.get(phone);
    const prevTs = parseTimestamp(prev?.indexedAt || prev?.createdAt) || 0;
    const nowTs = parseTimestamp(row.indexedAt || row.createdAt) || 0;
    if (!prev || nowTs >= prevTs) {
      latestByPhone.set(phone, row);
    }
  }
  return latestByPhone;
};

const run = async () => {
  const indexedUsers = await loadIndexedUsers();

  const phoneSet = new Set(indexedUsers.keys());
  for (const phone of options.phones) {
    phoneSet.add(phone);
  }

  const phones = Array.from(phoneSet).sort();

  if (phones.length === 0) {
    console.log('未找到推荐人索引数据。');
    console.log(`请先让推荐人登录一次 https://xiake.shop/ref.html（已自动写入 ${kvKeyUsersIndex()}）。`);
    console.log('或使用 --phones=13800138000,13900139000 指定手机号进行查询。');
    return;
  }

  const recommenders = [];

  for (const phone of phones) {
    const user = await kvGetJson(kvKeyUser(phone));
    const indexMeta = indexedUsers.get(phone) || {};
    const refCode = String(user?.refCode || indexMeta.refCode || '').trim();
    const level = user?.level === 'pro' ? 'pro' : 'normal';

    const ordersRaw = refCode ? await kvGetText(kvKeyOrders(refCode)) : null;
    const orderRows = parseLineJsonList(ordersRaw);
    const orders = getLatestByOrderNo(orderRows);

    const settlesRaw = await kvGetText(kvKeySettles(phone));
    const settlements = parseLineJsonList(settlesRaw).sort(
      (a, b) => (parseTimestamp(b.createdAt) || 0) - (parseTimestamp(a.createdAt) || 0)
    );

    const settlementStateMap = buildSettlementStateMap(settlements);

    let paidOrders = 0;
    let rebateTotalFen = 0;
    let eligibleFen = 0;

    for (const order of orders) {
      const orderRebateFen = Number(order.rebateFen) || rebateByLevel(order.refLevel === 'pro' ? 'pro' : level);
      const paidAtTs = parseTimestamp(order.paidAt);
      if (paidAtTs || order.payStatus === 'paid') {
        paidOrders += 1;
      }
      rebateTotalFen += orderRebateFen;

      const settleState = settlementStateMap.get(order.outTradeNo);
      const isLockedBySettlement = settleState === 'pending' || settleState === 'paid';
      if (!isLockedBySettlement && paidAtTs && Date.now() - paidAtTs >= TEN_DAYS_MS) {
        eligibleFen += orderRebateFen;
      }
    }

    const pendingSettleFen = settlements
      .filter((s) => (s.status || 'pending') === 'pending')
      .reduce((sum, s) => sum + (Number(s.amountFen) || 0), 0);

    const paidSettleFen = settlements
      .filter((s) => s.status === 'paid')
      .reduce((sum, s) => sum + (Number(s.amountFen) || 0), 0);

    recommenders.push({
      phone,
      refCode: refCode || '-',
      level,
      user,
      stats: {
        totalOrders: orders.length,
        paidOrders,
        rebateTotalFen,
        eligibleFen,
        settlements: settlements.length,
        pendingSettleFen,
        paidSettleFen,
      },
      orders,
      settlements,
    });
  }

  const totals = recommenders.reduce(
    (acc, item) => {
      acc.recommenders += 1;
      acc.totalOrders += item.stats.totalOrders;
      acc.paidOrders += item.stats.paidOrders;
      acc.rebateTotalFen += item.stats.rebateTotalFen;
      acc.eligibleFen += item.stats.eligibleFen;
      acc.pendingSettleFen += item.stats.pendingSettleFen;
      acc.paidSettleFen += item.stats.paidSettleFen;
      return acc;
    },
    {
      recommenders: 0,
      totalOrders: 0,
      paidOrders: 0,
      rebateTotalFen: 0,
      eligibleFen: 0,
      pendingSettleFen: 0,
      paidSettleFen: 0,
    }
  );

  const report = {
    generatedAt: new Date().toISOString(),
    kvBase: options.kvBase,
    prefix: options.prefix,
    usersIndexKey: kvKeyUsersIndex(),
    totals,
    recommenders,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`生成时间: ${formatTime(report.generatedAt)}`);
  console.log(`KV: ${report.kvBase}  前缀: ${report.prefix}`);
  console.log(`推荐人总数: ${totals.recommenders}`);
  console.log(`订单总数: ${totals.totalOrders}  已支付: ${totals.paidOrders}`);
  console.log(
    `返佣总额: ${formatFen(totals.rebateTotalFen)}  可结算: ${formatFen(totals.eligibleFen)}  待打款: ${formatFen(
      totals.pendingSettleFen
    )}  已打款: ${formatFen(totals.paidSettleFen)}`
  );

  for (const item of recommenders) {
    console.log('\n------------------------------------------------------------');
    console.log(`${item.phone}  ${levelLabel(item.level)}  推荐码: ${item.refCode}`);
    console.log(
      `订单 ${item.stats.totalOrders} (已支付 ${item.stats.paidOrders}) | 返佣 ${formatFen(item.stats.rebateTotalFen)} | 可结算 ${formatFen(
        item.stats.eligibleFen
      )} | 提现单 ${item.stats.settlements}`
    );

    if (item.orders.length === 0) {
      console.log('  订单: 无');
    } else {
      console.log('  订单:');
      for (const order of item.orders) {
        const rebateFen = Number(order.rebateFen) || rebateByLevel(order.refLevel === 'pro' ? 'pro' : item.level);
        const status = order.paidAt || order.payStatus === 'paid' ? 'paid' : (order.payStatus || 'created');
        console.log(
          `    - ${formatTime(order.createdAt)} | ${order.outTradeNo || '-'} | 金额 ${formatFen(order.feeFen)} | 返佣 ${formatFen(
            rebateFen
          )} | ${status}`
        );
      }
    }

    if (item.settlements.length === 0) {
      console.log('  提现: 无');
    } else {
      console.log('  提现:');
      for (const settle of item.settlements) {
        const status = settle.status || 'pending';
        const ordersCount = Array.isArray(settle.orderNos) ? settle.orderNos.length : 0;
        console.log(
          `    - ${settle.id || '-'} | ${formatTime(settle.createdAt)} | 订单 ${ordersCount} | 金额 ${formatFen(
            settle.amountFen
          )} | ${status}`
        );
      }
    }
  }
};

run().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
