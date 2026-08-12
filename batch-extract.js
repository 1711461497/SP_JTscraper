'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// ---- 配置 ----
const SAUCEPAN_BASE = 'https://saucepan.ai';
const SAUCEPAN_ORIGIN = 'https://saucepan.ai';
const SAUCEPAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const OUTPUT_DIR = path.join(__dirname, 'output');
const PAGE_SIZE = 24;

let token = '';

function headers(withAuth) {
  const h = {
    'User-Agent': SAUCEPAN_UA,
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    Origin: SAUCEPAN_ORIGIN,
    Referer: `${SAUCEPAN_ORIGIN}/`,
    'x-saucepan-client-version': '1',
  };
  if (withAuth && token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function readBody(response) {
  const ce = (response.headers.get('content-encoding') || '').toLowerCase();
  if (ce.includes('zstd')) {
    const buf = Buffer.from(await response.arrayBuffer());
    return zlib.zstdDecompressSync(buf).toString('utf8');
  }
  return response.text();
}

// ---- fragment 解密/重组 ----
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function fragmentHash(mask, derivedKey, text) {
  const bytes = new TextEncoder().encode(text);
  let h = (FNV_OFFSET ^ rotl(mask, 7) ^ rotl(derivedKey, 13)) >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

function assembleFragments(content) {
  const fragments = Array.isArray(content && content.fragments) ? content.fragments : [];
  const mask = ((content && content.mask) || 0) >>> 0;
  return fragments
    .filter((f) => {
      if (!f || typeof f.text !== 'string') return false;
      const derivedKey = (f.key ^ mask) >>> 0;
      return fragmentHash(mask, derivedKey, f.text) === (f.proof >>> 0);
    })
    .sort((a, b) => ((a.key ^ mask) >>> 0) - ((b.key ^ mask) >>> 0))
    .map((f) => f.text)
    .join('');
}

// ---- API helpers ----
async function fetchJson(apiPath, withAuth) {
  const response = await fetch(`${SAUCEPAN_BASE}${apiPath}`, { method: 'GET', headers: headers(withAuth) });
  let data = null;
  try { data = JSON.parse(await readBody(response)); } catch (_) {}
  return { ok: response.ok, status: response.status, data };
}

async function postJson(apiPath, body) {
  const response = await fetch(`${SAUCEPAN_BASE}${apiPath}`, {
    method: 'POST',
    headers: { ...headers(true), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = JSON.parse(await readBody(response)); } catch (_) {}
  return { ok: response.ok, status: response.status, data };
}

function parseCompanionId(url) {
  const m = String(url || '').match(/(?:saucepan\.ai\/companion\/)?([a-f0-9-]{8,64})/i);
  return m ? m[1] : null;
}

async function login(handle, password) {
  const response = await fetch(`${SAUCEPAN_BASE}/api/v1/auth/sign_in_password`, {
    method: 'POST',
    headers: { ...headers(false), 'Content-Type': 'application/json', Referer: `${SAUCEPAN_ORIGIN}/sign-in` },
    body: JSON.stringify({ handle: handle.trim(), password }),
  });
  let data = {};
  try { data = JSON.parse(await readBody(response)); } catch (_) {}
  if (!response.ok) {
    throw new Error((data?.error?.message) || `登录失败 HTTP ${response.status}`);
  }
  const t = data.token || data.access_token || data.session_token || data.sessionToken;
  if (!t) throw new Error('登录成功但未返回 token');
  token = t;
  return t;
}

// ---- 搜索 API：获取 companion 列表 ----

/**
 * 搜索全站 companions（浏览最新/热门等）
 * order_by: trending | popularity | created | updated | name | random
 */
async function searchCompanions({ query = '', orderBy = 'created', asc = false, offset = 0 } = {}) {
  const body = { query, sus: true, order_by: orderBy, asc, offset };
  return postJson('/api/v1/search', body);
}

/**
 * 获取某个用户的所有 companions
 * 需要先通过 handle 拿到 user_id
 */
async function getUserCompanions(userId, { orderBy = 'created', asc = false, offset = 0 } = {}) {
  const body = {
    query: '',
    sus: true,
    order_by: orderBy,
    asc,
    offset,
    special_view: { view: 'user_profile', user_id: userId },
  };
  return postJson('/api/v1/search', body);
}

/** 通过 handle 获取用户信息（包含 user_id） */
async function getUserByHandle(handle) {
  const res = await fetchJson(`/api/v1/user-page?handle=${encodeURIComponent(handle)}`, true);
  if (!res.ok || !res.data?.user) {
    throw new Error(`找不到用户: ${handle}`);
  }
  return res.data.user;
}

/** 自动翻页获取所有 companion IDs */
async function fetchAllCompanionIds(fetchFn) {
  const allCompanions = [];
  let offset = 0;

  const first = await fetchFn(offset);
  if (!first.ok) throw new Error(`API 请求失败: HTTP ${first.status}`);

  const total = first.data?.total_count || 0;
  const comps = first.data?.companions || [];
  allCompanions.push(...comps);

  console.log(`  共 ${total} 个 companions，已获取 ${allCompanions.length}...`);

  while (allCompanions.length < total) {
    offset += PAGE_SIZE;
    await sleep(300);
    const res = await fetchFn(offset);
    if (!res.ok) break;
    const batch = res.data?.companions || [];
    if (batch.length === 0) break;
    allCompanions.push(...batch);
    console.log(`  已获取 ${allCompanions.length}/${total}...`);
  }

  return allCompanions;
}

// ---- 提取单个 companion ----
async function extractCompanion(companionId) {
  const [defRes, compRes] = await Promise.all([
    fetchJson(`/api/v1/companion/definition?companion_id=${encodeURIComponent(companionId)}`, true),
    fetchJson(`/api/v2/companions/${encodeURIComponent(companionId)}`, true),
  ]);

  const sections = {};
  if (defRes.ok && defRes.data?.sections) {
    for (const s of defRes.data.sections) {
      if (s?.title && s?.content) sections[s.title] = assembleFragments(s.content);
    }
  }

  const companion = compRes.data?.companion || null;

  let description = sections['Companion Core'] || '';
  if (!description && companion?.full_description_fragments) {
    description = assembleFragments(companion.full_description_fragments);
  }

  const greetings = [];
  if (companion?.starting_scenarios_fragments) {
    for (const sc of companion.starting_scenarios_fragments) {
      const text = assembleFragments(sc?.message);
      if (text?.trim()) greetings.push(text);
    }
  }

  const shortDesc = companion?.short_description?.trim() || '';

  return {
    companionId,
    name: companion?.display_name || companion?.name || 'Unknown',
    shortDescription: shortDesc,
    description,
    exampleDialogue: sections['Example Dialogue'] || '',
    advancedPrompt: sections['Advanced Prompt'] || '',
    responseFormatting: sections['Response Formatting Instructions'] || '',
    firstMessage: greetings[0] || '',
    alternateGreetings: greetings.slice(1),
    tags: companion?.tags || [],
    definitionOpen: defRes.ok,
  };
}

// ---- 批量提取 ----
async function batchExtract(companionList) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let success = 0;
  let fail = 0;
  const total = companionList.length;

  for (let i = 0; i < total; i++) {
    const { id, name: listName } = companionList[i];
    const num = `[${i + 1}/${total}]`;
    try {
      const result = await extractCompanion(id);
      const filename = `${result.name.replace(/[\/\\:*?"<>|]/g, '_')}_${id.slice(0, 8)}.json`;
      const outPath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
      const defStatus = result.definitionOpen ? '完整' : '部分(定义隐藏)';
      console.log(`${num} ✓ ${result.name} [${defStatus}] -> ${filename}`);
      success++;
    } catch (e) {
      console.error(`${num} ✗ ${listName || id} - ${e.message}`);
      fail++;
    }
    if (i < total - 1) await sleep(500);
  }

  console.log(`\n完成！成功: ${success}, 失败: ${fail}`);
  console.log(`输出目录: ${OUTPUT_DIR}`);
}

// ---- 工具函数 ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function ensureLogin() {
  const tokenFile = path.join(__dirname, '.token');
  if (fs.existsSync(tokenFile)) {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (token) {
      console.log('已加载保存的 Token\n');
      return;
    }
  }
  const handle = await prompt('Saucepan 用户名: ');
  const password = await prompt('Saucepan 密码: ');
  await login(handle, password);
  fs.writeFileSync(tokenFile, token, 'utf8');
  console.log('登录成功！Token 已保存\n');
}

function showHelp() {
  console.log(`
=== Saucepan 批量提取工具 ===

用法:
  node batch-extract.js                     从 urls.txt 读取链接并提取
  node batch-extract.js --user <用户名>     提取某个创作者的所有 companions
  node batch-extract.js --browse [数量]     提取最新发布的 companions（默认 24 个）
  node batch-extract.js --trending [数量]   提取热门 companions（默认 24 个）
  node batch-extract.js --list-only         仅列出 URL，不提取内容（配合 --user/--browse/--trending 使用）

示例:
  node batch-extract.js --user RetroDoomer
  node batch-extract.js --user RetroDoomer --list-only
  node batch-extract.js --browse 48
  node batch-extract.js --trending 100
`);
}

// ---- 主流程 ----
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }

  const listOnly = args.includes('--list-only');
  const userIdx = args.indexOf('--user');
  const browseIdx = args.indexOf('--browse');
  const trendingIdx = args.indexOf('--trending');

  await ensureLogin();

  // ---- 模式 1: 按创作者提取 ----
  if (userIdx !== -1) {
    const handle = args[userIdx + 1];
    if (!handle || handle.startsWith('--')) {
      console.error('请提供用户名，例如: --user RetroDoomer');
      process.exit(1);
    }

    console.log(`正在查找用户 ${handle} 的信息...`);
    const user = await getUserByHandle(handle);
    console.log(`找到用户: ${user.handle} (${user.id})\n`);

    console.log(`正在获取 ${handle} 的所有 companions...`);
    const companions = await fetchAllCompanionIds(
      (offset) => getUserCompanions(user.id, { offset })
    );

    if (companions.length === 0) {
      console.log('该用户没有公开的 companions。');
      return;
    }

    console.log(`\n共找到 ${companions.length} 个 companions:\n`);
    for (const c of companions) {
      console.log(`  ${c.display_name}  https://saucepan.ai/companion/${c.id}`);
    }

    if (listOnly) return;

    console.log(`\n开始批量提取...\n`);
    const list = companions.map(c => ({ id: c.id, name: c.display_name }));
    await batchExtract(list);
    return;
  }

  // ---- 模式 2: 浏览最新 ----
  if (browseIdx !== -1) {
    const count = parseInt(args[browseIdx + 1]) || PAGE_SIZE;
    console.log(`正在获取最新 ${count} 个 companions...\n`);

    const companions = [];
    let offset = 0;
    while (companions.length < count) {
      const res = await searchCompanions({ orderBy: 'created', offset });
      if (!res.ok) { console.error('API 请求失败'); break; }
      const batch = res.data?.companions || [];
      if (batch.length === 0) break;
      companions.push(...batch);
      offset += PAGE_SIZE;
      if (companions.length < count) await sleep(300);
    }
    const result = companions.slice(0, count);

    console.log(`找到 ${result.length} 个 companions:\n`);
    for (const c of result) {
      console.log(`  ${c.display_name} (by ${c.author_handle})  https://saucepan.ai/companion/${c.id}`);
    }

    if (listOnly) return;

    console.log(`\n开始批量提取...\n`);
    const list = result.map(c => ({ id: c.id, name: c.display_name }));
    await batchExtract(list);
    return;
  }

  // ---- 模式 3: 浏览热门 ----
  if (trendingIdx !== -1) {
    const count = parseInt(args[trendingIdx + 1]) || PAGE_SIZE;
    console.log(`正在获取热门 ${count} 个 companions...\n`);

    const companions = [];
    let offset = 0;
    while (companions.length < count) {
      const res = await searchCompanions({ orderBy: 'trending', offset });
      if (!res.ok) { console.error('API 请求失败'); break; }
      const batch = res.data?.companions || [];
      if (batch.length === 0) break;
      companions.push(...batch);
      offset += PAGE_SIZE;
      if (companions.length < count) await sleep(300);
    }
    const result = companions.slice(0, count);

    console.log(`找到 ${result.length} 个 companions:\n`);
    for (const c of result) {
      console.log(`  ${c.display_name} (by ${c.author_handle})  https://saucepan.ai/companion/${c.id}`);
    }

    if (listOnly) return;

    console.log(`\n开始批量提取...\n`);
    const list = result.map(c => ({ id: c.id, name: c.display_name }));
    await batchExtract(list);
    return;
  }

  // ---- 模式 0: 从 urls.txt 读取 ----
  const urlsFile = path.join(__dirname, 'urls.txt');
  if (!fs.existsSync(urlsFile)) {
    showHelp();
    console.log('或创建 urls.txt 文件，每行一个链接后直接运行。');
    fs.writeFileSync(urlsFile, '# 每行一个链接，例如：\n# https://saucepan.ai/companion/8af6a971-2dc6-4789-abc7-b41e6dea10b0\n', 'utf8');
    return;
  }

  const urls = fs.readFileSync(urlsFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (urls.length === 0) {
    console.log('urls.txt 中没有有效链接。');
    showHelp();
    return;
  }

  console.log(`从 urls.txt 读取 ${urls.length} 个链接\n`);
  const list = urls.map(url => {
    const id = parseCompanionId(url);
    return { id: id || url, name: url };
  });
  await batchExtract(list);
}

main().catch(e => { console.error(e); process.exit(1); });
