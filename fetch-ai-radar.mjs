#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCES = path.join(__dirname, "sources.json");
const DEFAULT_HTML = path.join(__dirname, "index.html");
const DEFAULT_JSON = path.join(__dirname, "ai-radar-data.json");
const DESKTOP_HTML_TARGETS = [
  path.join(__dirname, "Desktop", "AI Radar.html"),
  path.join(__dirname, "OneDrive", "Desktop", "AI Radar.html")
];

const args = parseArgs(process.argv.slice(2));
const sourcesPath = path.resolve(args.sources || DEFAULT_SOURCES);
const outPath = path.resolve(args.out || DEFAULT_JSON);
const htmlPath = path.resolve(args.html || DEFAULT_HTML);

main().catch((error) => {
  console.error(`AI Radar failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const config = JSON.parse(await readFile(sourcesPath, "utf8"));
  const meta = config.meta || {};
  const enabledSources = (config.sources || []).filter((source) => source.enabled !== false);
  const days = Number(args.days || meta.defaultDays || 21);
  const limit = Number(args.limit || meta.defaultLimit || 180);
  const delayMs = Number(args.delay || meta.requestDelayMs || 650);
  const timeoutMs = Number(args.timeout || meta.timeoutMs || 15000);
  const userAgent = args.userAgent || meta.userAgent || "AI-Radar/1.0";
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const results = [];
  const errors = [];

  for (const [index, source] of enabledSources.entries()) {
    if (index > 0) await sleep(delayMs);
    process.stderr.write(`Fetching ${source.name}...\n`);

    try {
      const text = await fetchText(source.url, { timeoutMs, userAgent });
      const parsed = parseSource(text, source);
      const normalized = parsed
        .map((item) => normalizeItem(item, source, config.categories || []))
        .filter((item) => item.title && item.url)
        .filter((item) => item.timestamp === null || item.timestamp >= cutoff);

      results.push(...normalized);
    } catch (error) {
      errors.push({
        source: source.name,
        url: source.url,
        message: error.message
      });
      process.stderr.write(`  skipped: ${error.message}\n`);
    }
  }

  const deduped = dedupe(results)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);

  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totalItems: deduped.length,
    sourceCount: enabledSources.length,
    categories: config.categories || [],
    items: deduped,
    errors
  };

  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote ${outPath}\n`);

  if (args.embed !== false && existsSync(htmlPath)) {
    const embeddedHtml = await embedDataIntoHtml(htmlPath, payload);
    process.stderr.write(`Embedded data into ${htmlPath}\n`);

    if (path.resolve(htmlPath) === path.resolve(DEFAULT_HTML)) {
      for (const target of DESKTOP_HTML_TARGETS) {
        if (!existsSync(path.dirname(target))) continue;
        await writeFile(target, embeddedHtml, "utf8");
        process.stderr.write(`Synced desktop page to ${target}\n`);
      }
    }
  }

  if (args.summary !== false) {
    printSummary(payload);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    if (key === "no-embed") {
      parsed.embed = false;
    } else if (key === "no-summary") {
      parsed.summary = false;
    } else {
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

async function fetchText(url, { timeoutMs, userAgent }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": userAgent,
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseSource(text, source) {
  const lower = text.slice(0, 800).toLowerCase();
  if (source.type === "html" || lower.includes("<html")) return parseHtml(text, source);
  if (source.type === "atom" || lower.includes("<feed")) return parseAtom(text);
  return parseRss(text);
}

function parseRss(xml) {
  const itemBlocks = matchBlocks(xml, "item");
  return itemBlocks.map((block) => ({
    title: pickTag(block, "title"),
    url: pickTag(block, "link") || pickTag(block, "guid"),
    publishedAt: pickTag(block, "pubDate") || pickTag(block, "dc:date") || pickTag(block, "updated"),
    summary: pickTag(block, "description") || pickTag(block, "content:encoded")
  }));
}

function parseAtom(xml) {
  const entryBlocks = matchBlocks(xml, "entry");
  return entryBlocks.map((block) => ({
    title: pickTag(block, "title"),
    url: pickAtomLink(block) || pickTag(block, "id"),
    publishedAt: pickTag(block, "published") || pickTag(block, "updated"),
    summary: pickTag(block, "summary") || pickTag(block, "content")
  }));
}

function parseHtml(html, source) {
  const titleByUrl = new Map();
  const base = new URL(source.url);
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html))) {
    const href = match[1];
    const rawTitle = stripHtml(match[2]);
    const title = decodeEntities(rawTitle).replace(/\s+/g, " ").trim();
    if (!title || title.length < 8) continue;

    try {
      const url = new URL(href, base).toString();
      if (!/^https?:/.test(url)) continue;
      titleByUrl.set(url.split("#")[0], title);
    } catch {
      continue;
    }
  }

  return [...titleByUrl.entries()].map(([url, title]) => ({
    title,
    url,
    publishedAt: "",
    summary: ""
  }));
}

function normalizeItem(item, source, categories) {
  const title = cleanText(item.title);
  const summary = cleanText(item.summary).slice(0, 420);
  const url = normalizeUrl(cleanText(item.url), source.url);
  const date = parseDate(item.publishedAt);
  const text = `${title} ${summary} ${source.name}`.toLowerCase();
  const matchedCategories = categorize(text, categories);

  return {
    id: stableId(`${title}|${url}`),
    title,
    url,
    summary,
    publishedAt: date ? date.toISOString() : null,
    timestamp: date ? date.getTime() : null,
    source: {
      id: source.id,
      name: source.name,
      region: source.region || "Global",
      trust: source.trust || "unknown"
    },
    categories: matchedCategories.length ? matchedCategories : ["applications"],
    score: scoreItem({ title, summary, date, source, matchedCategories })
  };
}

function categorize(text, categories) {
  return categories
    .map((category) => ({
      id: category.id,
      hits: (category.keywords || []).reduce((count, keyword) => {
        return count + (text.includes(keyword.toLowerCase()) ? 1 : 0);
      }, 0)
    }))
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((item) => item.id);
}

function scoreItem({ title, summary, date, source, matchedCategories }) {
  let score = 30;
  const ageHours = date ? Math.max(1, (Date.now() - date.getTime()) / 36e5) : 240;
  score += Math.max(0, 35 - ageHours / 4);
  score += matchedCategories.length * 8;
  if (source.trust === "official") score += 18;
  if (source.trust === "research") score += 12;
  if (/\b(release|launch|announc|introduc|open source|benchmark|funding|regulation|safety)\b/i.test(`${title} ${summary}`)) score += 10;
  return Math.round(Math.min(score, 100));
}

function dedupe(items) {
  const seen = new Map();
  for (const item of items) {
    const key = canonicalKey(item.url) || slug(item.title);
    const previous = seen.get(key);
    if (!previous || item.score > previous.score || item.timestamp > previous.timestamp) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

async function embedDataIntoHtml(htmlPath, payload) {
  const html = await readFile(htmlPath, "utf8");
  const serialized = escapeScriptJson(JSON.stringify(payload, null, 2));
  const pattern = /(<script id="ai-radar-data" type="application\/json">)([\s\S]*?)(<\/script>)/;

  if (!pattern.test(html)) {
    return html;
  }

  const next = html.replace(pattern, (_match, open, _oldPayload, close) => `${open}\n${serialized}\n${close}`);
  await writeFile(htmlPath, next, "utf8");
  return next;
}

function printSummary(payload) {
  const counts = new Map();
  for (const item of payload.items) {
    for (const category of item.categories) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }

  console.log(`AI Radar: ${payload.totalItems} items from ${payload.sourceCount} sources`);
  console.log(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => `${id}:${count}`)
      .join("  ")
  );

  if (payload.errors.length) {
    console.log(`Warnings: ${payload.errors.length} source(s) failed. See ai-radar-data.json for details.`);
  }
}

function matchBlocks(text, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  const blocks = [];
  let match;
  while ((match = pattern.exec(text))) blocks.push(match[1]);
  return blocks;
}

function pickTag(block, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const match = block.match(pattern);
  return match ? decodeEntities(stripCdata(match[1])).trim() : "";
}

function pickAtomLink(block) {
  const alternate = block.match(/<link\b(?=[^>]*rel=["']alternate["'])(?=[^>]*href=["']([^"']+)["'])[^>]*\/?>/i);
  const first = alternate || block.match(/<link\b(?=[^>]*href=["']([^"']+)["'])[^>]*\/?>/i);
  return first ? first[1] : "";
}

function cleanText(value) {
  return decodeEntities(stripHtml(stripCdata(String(value || ""))))
    .replace(/\s+/g, " ")
    .trim();
}

function stripCdata(value) {
  return String(value || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };

  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, name) => named[name] || `&${name};`);
}

function parseDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(cleanText(value));
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function normalizeUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function canonicalKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) parsed.searchParams.delete(key);
    }
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stableId(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `ai-${(hash >>> 0).toString(36)}`;
}

function escapeScriptJson(value) {
  return value
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
