#!/usr/bin/env node

const usage = () => {
  console.log(
    [
      'Usage: node scripts/upgrade-all-referrers.mjs [options]',
      '',
      'Options:',
      '  --kv-base=<url>      KV base URL (default: https://kv.minapp.xin)',
      '  --prefix=<name>      KV prefix (default: xiake)',
      '  --level=<normal|pro> Target level (default: pro)',
      '  --dry-run            Preview only, do not write',
      '  -h, --help           Show help',
      '',
      'Examples:',
      '  node scripts/upgrade-all-referrers.mjs',
      '  node scripts/upgrade-all-referrers.mjs --dry-run',
      '  node scripts/upgrade-all-referrers.mjs --level=pro',
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
  level: 'pro',
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
  } else if (key === 'level') {
    options.level = value || options.level;
  } else {
    console.error(`Unknown option: --${key}`);
    usage();
    process.exit(1);
  }
}

options.kvBase = options.kvBase.replace(/\/$/, '');
options.level = options.level === 'pro' ? 'pro' : options.level === 'normal' ? 'normal' : '';
if (!options.level) {
  console.error('Invalid --level, must be normal or pro');
  process.exit(1);
}

const normalizeLevel = (level) => (level === 'pro' ? 'pro' : 'normal');
const usersIndexKey = `${options.prefix}:ref:users`;
const userKey = (phone) => `${options.prefix}:ref:user:${phone}`;
const kvUrl = (key) => `${options.kvBase}/kv/${encodeURIComponent(key)}`;

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

const run = async () => {
  const phones = await listPhones();
  if (phones.length === 0) {
    console.log('No recommenders found in users index.');
    return;
  }

  let updated = 0;
  let unchanged = 0;
  let missing = 0;
  let failed = 0;

  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`Target level: ${options.level}`);
  console.log(`Found recommenders: ${phones.length}`);

  for (const phone of phones) {
    const key = userKey(phone);
    try {
      const user = await kvGetJson(key);
      if (!user) {
        missing += 1;
        console.log(`MISS ${phone} user record not found`);
        continue;
      }
      const oldLevel = normalizeLevel(user.level);
      if (oldLevel === options.level) {
        unchanged += 1;
        console.log(`SKIP ${phone} already ${oldLevel}`);
        continue;
      }
      if (options.dryRun) {
        updated += 1;
        console.log(`PLAN ${phone} ${oldLevel} -> ${options.level}`);
        continue;
      }
      user.level = options.level;
      user.updatedAt = Date.now();
      await kvPutJson(key, user);
      updated += 1;
      console.log(`OK   ${phone} ${oldLevel} -> ${options.level}`);
    } catch (error) {
      failed += 1;
      console.log(`ERR  ${phone} ${error.message}`);
    }
  }

  console.log('\nSummary');
  console.log(`updated:   ${updated}`);
  console.log(`unchanged: ${unchanged}`);
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
