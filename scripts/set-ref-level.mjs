#!/usr/bin/env node

const usage = () => {
  console.log([
    'Usage: node scripts/set-ref-level.mjs <phone> <normal|pro> [--kv-base=https://kv.minapp.xin] [--prefix=xiake]',
    'Example: node scripts/set-ref-level.mjs 13800138000 pro',
  ].join('\n'));
};

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}
if (args.length < 2) {
  usage();
  process.exit(1);
}

const phone = String(args[0] || '').trim();
const levelRaw = String(args[1] || '').trim().toLowerCase();
const level = levelRaw === 'pro' ? 'pro' : levelRaw === 'normal' ? 'normal' : null;

const opts = {};
for (const arg of args.slice(2)) {
  if (!arg.startsWith('--')) continue;
  const [k, v = ''] = arg.slice(2).split('=');
  opts[k] = v;
}

const kvBase = (opts['kv-base'] || 'https://kv.minapp.xin').replace(/\/$/, '');
const prefix = opts.prefix || 'xiake';

if (!/^1\d{10}$/.test(phone)) {
  console.error('Invalid phone: expected 11-digit mainland mobile, e.g. 13800138000');
  process.exit(1);
}
if (!level) {
  console.error('Invalid level: must be normal or pro');
  process.exit(1);
}

if (typeof fetch !== 'function') {
  console.error('This script requires Node.js 18+ (global fetch is not available).');
  process.exit(1);
}

const userKey = `${prefix}:ref:user:${phone}`;
const usersIndexKey = `${prefix}:ref:users`;
const userIndexedFlagKey = `${prefix}:ref:user-indexed:${phone}`;
const refCodeKey = (code) => `${prefix}:ref:code:${code}`;
const userUrl = `${kvBase}/kv/${encodeURIComponent(userKey)}`;
const kvUrl = (key) => `${kvBase}/kv/${encodeURIComponent(key)}`;

const randomRefCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

const readUser = async () => {
  const res = await fetch(userUrl);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`KV GET failed: ${res.status}`);
  }
  const text = (await res.text()).trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('User record is not valid JSON');
  }
};

const writeUser = async (user) => {
  const res = await fetch(userUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  });
  if (!res.ok) {
    throw new Error(`KV PUT failed: ${res.status}`);
  }
};

const kvGetText = async (key) => {
  const res = await fetch(kvUrl(key));
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`KV GET failed: ${res.status} (${key})`);
  }
  return (await res.text()).trim();
};

const kvPutText = async (key, text, contentType = 'text/plain;charset=UTF-8') => {
  const res = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: text,
  });
  if (!res.ok) {
    throw new Error(`KV PUT failed: ${res.status} (${key})`);
  }
};

const kvPushLine = async (key, payload) => {
  const res = await fetch(`${kvUrl(key)}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: `${JSON.stringify(payload)}\n`,
  });
  if (!res.ok) {
    throw new Error(`KV PUSH failed: ${res.status} (${key})`);
  }
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
  const user = await readUser();
  if (!user) {
    throw new Error(`User not found for phone: ${phone} (key: ${userKey})`);
  }

  const oldLevel = user.level === 'pro' ? 'pro' : 'normal';
  user.level = level;
  user.updatedAt = Date.now();

  let assignedRefCode = '';
  if (level === 'pro' && !String(user.refCode || '').trim()) {
    const code = await ensureUniqueCode();
    user.refCode = code;
    assignedRefCode = code;
    await kvPutText(refCodeKey(code), phone);
    await kvPushLine(usersIndexKey, {
      phone,
      refCode: code,
      createdAt: user.createdAt || user.updatedAt,
      indexedAt: user.updatedAt,
    });
    await kvPutText(userIndexedFlagKey, '1');
  }

  await writeUser(user);

  console.log(`OK: ${phone} level ${oldLevel} -> ${level}`);
  console.log(`KV key: ${userKey}`);
  if (assignedRefCode) {
    console.log(`Assigned refCode: ${assignedRefCode}`);
  }
};

run().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
