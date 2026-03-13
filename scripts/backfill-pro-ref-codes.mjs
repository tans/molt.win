#!/usr/bin/env node

const usage = () => {
  console.log(
    [
      'Usage: node scripts/backfill-pro-ref-codes.mjs [options]',
      '',
      'Options:',
      '  --kv-base=<url>      KV base URL (default: https://kv.minapp.xin)',
      '  --prefix=<name>      KV prefix (default: xiake)',
      '  --dry-run            Preview only, do not write',
      '  -h, --help           Show help',
      '',
      'Examples:',
      '  node scripts/backfill-pro-ref-codes.mjs',
      '  node scripts/backfill-pro-ref-codes.mjs --dry-run',
    ].join('\n')
  );
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
  dryRun: false,
};

for (const arg of args) {
  if (arg === '--dry-run') {
    options.dryRun = true;
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
  } else {
    console.error(`Unknown option: --${key}`);
    usage();
    process.exit(1);
  }
}

options.kvBase = options.kvBase.replace(/\/$/, '');

const usersIndexKey = `${options.prefix}:ref:users`;
const userKey = (phone) => `${options.prefix}:ref:user:${phone}`;
const userIndexedFlagKey = (phone) => `${options.prefix}:ref:user-indexed:${phone}`;
const refCodeKey = (code) => `${options.prefix}:ref:code:${code}`;
const kvUrl = (key) => `${options.kvBase}/kv/${encodeURIComponent(key)}`;

const randomRefCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

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
    throw new Error(`Invalid JSON in key: ${key}`);
  }
};

const kvPutJson = async (key, payload) => {
  const response = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`KV PUT failed (${response.status}) for key ${key}`);
  }
};

const kvPutText = async (key, text) => {
  const response = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: text,
  });
  if (!response.ok) {
    throw new Error(`KV PUT failed (${response.status}) for key ${key}`);
  }
};

const kvPushLine = async (key, payload) => {
  const response = await fetch(`${kvUrl(key)}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: `${JSON.stringify(payload)}\n`,
  });
  if (!response.ok) {
    throw new Error(`KV PUSH failed (${response.status}) for key ${key}`);
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

const listPhones = async () => {
  const raw = await kvGetText(usersIndexKey);
  const rows = parseLineJsonList(raw);
  const phones = new Set();
  for (const row of rows) {
    const phone = String(row?.phone || '').trim();
    if (/^1\d{10}$/.test(phone)) {
      phones.add(phone);
    }
  }
  return Array.from(phones).sort();
};

const ensureUniqueCode = async () => {
  for (let i = 0; i < 12; i += 1) {
    const code = randomRefCode();
    const existing = await kvGetText(refCodeKey(code));
    if (!existing) {
      return code;
    }
  }
  throw new Error('Failed to generate unique ref code');
};

const run = async () => {
  const phones = await listPhones();
  if (phones.length === 0) {
    console.log('No recommenders found in users index.');
    return;
  }

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`Found recommenders: ${phones.length}`);

  for (const phone of phones) {
    scanned += 1;
    const key = userKey(phone);
    try {
      const user = await kvGetJson(key);
      if (!user) {
        missing += 1;
        console.log(`MISS ${phone} user record not found`);
        continue;
      }
      const level = user.level === 'pro' ? 'pro' : 'normal';
      const refCode = String(user.refCode || '').trim();
      if (level !== 'pro' || refCode) {
        skipped += 1;
        console.log(`SKIP ${phone} level=${level} refCode=${refCode || '-'}`);
        continue;
      }

      const nextCode = await ensureUniqueCode();
      if (options.dryRun) {
        updated += 1;
        console.log(`PLAN ${phone} assign refCode=${nextCode}`);
        continue;
      }

      user.refCode = nextCode;
      user.updatedAt = Date.now();
      await kvPutText(refCodeKey(nextCode), phone);
      await kvPushLine(usersIndexKey, {
        phone,
        refCode: nextCode,
        createdAt: user.createdAt || user.updatedAt,
        indexedAt: user.updatedAt,
      });
      await kvPutText(userIndexedFlagKey(phone), '1');
      await kvPutJson(key, user);

      updated += 1;
      console.log(`OK   ${phone} refCode=${nextCode}`);
    } catch (error) {
      failed += 1;
      console.log(`ERR  ${phone} ${error.message}`);
    }
  }

  console.log('\nSummary');
  console.log(`scanned:   ${scanned}`);
  console.log(`updated:   ${updated}`);
  console.log(`skipped:   ${skipped}`);
  console.log(`missing:   ${missing}`);
  console.log(`failed:    ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
};

run().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
