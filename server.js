require('dotenv').config();
const express    = require('express');
const { Client } = require('@notionhq/client');
const Anthropic  = require('@anthropic-ai/sdk');
const cheerio             = require('cheerio');
const { Readability }     = require('@mozilla/readability');
const { JSDOM }           = require('jsdom');
const path                = require('path');
const https      = require('https');
const http       = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotionClient() {
  return new Client({ auth: process.env.NOTION_API_KEY });
}

// @notionhq/client v5: pages.create needs data_source_id, not database_id.
// Resolve once from the database response and cache for the process lifetime.
let _dataSourceId = null;
async function getDataSourceId() {
  if (_dataSourceId) return _dataSourceId;
  const notion = makeNotionClient();
  const db = await notion.databases.retrieve({
    database_id: process.env.NOTION_DATABASE_ID,
  });
  _dataSourceId = db.data_sources[0].id;
  return _dataSourceId;
}

function notionErrorMessage(err) {
  if (err.code === 'unauthorized')     return 'Invalid API key. Double-check your NOTION_API_KEY in .env.';
  if (err.code === 'object_not_found') return 'Database not found. Verify your NOTION_DATABASE_ID and make sure you have connected the integration to the database in Notion.';
  if (err.code === 'validation_error') return `Notion rejected the request: ${err.message}`;
  return `Notion error: ${err.message}`;
}

// Decode common HTML entities found in <title> and og:title values
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g,     (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Detect bot-challenge / access-denied pages that return a meaningless title.
// Cloudflare, Imperva, and similar WAFs all share recognisable fingerprints.
const BOT_TITLES = new Set([
  'just a moment...',
  'attention required!',
  'one more step',
  'access denied',
  'enable javascript and cookies to continue',
  '403 forbidden',
  '404 not found',
  'error',
  'please wait...',
  'checking your browser...',
]);

function isBotChallenge(html, title) {
  if (BOT_TITLES.has(title.toLowerCase())) return true;
  // Cloudflare challenge-page fingerprints
  if (html.includes('window._cf_chl_opt') || html.includes('/cdn-cgi/challenge-platform/')) return true;
  // Generic "robots=noindex,nofollow" on an otherwise-blank page (< 4 KB)
  if (html.length < 4000 && /noindex.*nofollow/i.test(html)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Readability extraction — isolates the main article body, stripping nav,
// ads, sidebars, footers, and related-article sections automatically.
// Returns the full Readability result object, or null on failure / low confidence.
// ---------------------------------------------------------------------------

/**
 * @param {string} html    Full page HTML
 * @param {string} url     Original URL (used by Readability to resolve relative links)
 * @returns {{ title, content, textContent, length, excerpt } | null}
 */
function extractArticle(html, url) {
  try {
    const dom    = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document, { charThreshold: 20 });
    const article = reader.parse();
    // Reject blank or suspiciously short extractions — these usually mean
    // Readability hit a paywall stub, a redirect page, or a non-article page.
    if (!article || !article.content || article.length < 200) return null;
    return article;
  } catch (err) {
    console.error('[readability] extraction failed:', err.message);
    return null;
  }
}

// Strip HTML tags to produce plain text suitable for the summarisation prompt.
// Removes scripts/styles/head entirely; replaces block elements with newlines.
function stripHtml(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,  ' ')
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi,     ' ')
    .replace(/<\/?(p|div|section|article|h[1-6]|li|br|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// HTML fetching — reused by /api/fetch-title, /api/summarize, and /api/scrape
// Follows redirects, streams just enough HTML to find the title tag fast,
// or the full body when a larger chunk is needed (for summarisation/scraping).
// Uses rejectUnauthorized:false scoped to this function so it works on
// corporate/proxy networks without affecting Notion API calls.
// ---------------------------------------------------------------------------

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Fetch the HTML body of a URL, optionally stopping early.
 * @param {string} rawUrl
 * @param {object} opts
 * @param {number} opts.maxBytes      Stop streaming after this many bytes (default: 100 KB)
 * @param {RegExp} opts.stopAt        Stop as soon as this pattern is matched (optional)
 * @param {number} opts.maxRedirects
 */
function fetchHtmlChunk(rawUrl, { maxBytes = 100_000, stopAt, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let redirectsLeft = maxRedirects;

    function doRequest(url) {
      let parsed;
      try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

      const isHttps = parsed.protocol === 'https:';
      const mod     = isHttps ? https : http;
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        headers:  FETCH_HEADERS,
        timeout:  10000,
        ...(isHttps && { agent: new https.Agent({ rejectUnauthorized: false }) }),
      };

      let resolved = false;
      const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

      const req = mod.get(options, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft-- <= 0) return reject(new Error('Too many redirects'));
          return doRequest(new URL(res.headers.location, url).href);
        }

        const ct = res.headers['content-type'] ?? '';
        if (!ct.includes('text/html')) { res.resume(); return done(''); }

        res.setEncoding('utf8');
        let html = '';
        res.on('data', chunk => {
          html += chunk;
          if (html.length >= maxBytes || (stopAt && stopAt.test(html))) {
            done(html);
            req.destroy(); // intentional — error handler ignores post-resolve errors
          }
        });
        res.on('end',  () => done(html));
        res.on('error', err => { if (!resolved) reject(err); });
      });

      req.on('error', err => { if (!resolved) reject(err); });
      req.on('timeout', () => {
        req.destroy();
        if (!resolved) reject(Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }));
      });
    }

    doRequest(rawUrl);
  });
}

// ---------------------------------------------------------------------------
// Scraping — cheerio-based HTML → Notion block conversion
// ---------------------------------------------------------------------------

// Tags that are always skipped during DOM traversal
const SCRAPE_SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'head',
  'nav', 'header', 'footer', 'aside',
  'form', 'input', 'button', 'select', 'textarea',
  'svg', 'canvas', 'video', 'audio',
  'iframe', 'embed', 'object',
  'figcaption',     // preserve <figure> to reach <img> inside it
]);

/**
 * Parse HTML into an array of raw block descriptors ready for blocksToNotion().
 * @param {string} html     Full page HTML
 * @param {string} baseUrl  Original URL used to resolve relative links/images
 * @returns {Array}
 */
function scrapeBlocks(html, baseUrl) {
  const $ = cheerio.load(html);

  // Remove globally noisy elements before traversal
  $(
    'script, style, noscript, nav, header, footer, aside, form,' +
    '[role="navigation"], [role="banner"], [role="complementary"], [role="dialog"]'
  ).remove();

  // Prefer a semantic content container; fall back to <body>
  const candidate = $('article, [role="main"], main, .article-content, .post-content, .entry-content').first();
  const rootNode  = candidate.length ? candidate[0] : $('body')[0];

  // --- inner helpers (closures capture $ and baseUrl) ---

  function resolveUrl(src) {
    if (!src) return null;
    try { return new URL(src, baseUrl).href; } catch { return null; }
  }

  /**
   * Walk inline content of an element, producing rich-text segment objects.
   * Handles nested <a>, <strong>/<b>, <em>/<i>, <code>, <s>/<del>, <u>, <br>.
   */
  function extractRichText(el, parentAnnotations = {}) {
    const segments = [];
    $(el).contents().each((_, node) => {
      if (node.type === 'text') {
        const text = (node.data || '')
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/ {2,}/g, ' ');
        if (text) segments.push({ text, href: null, annotations: { ...parentAnnotations } });

      } else if (node.type === 'tag') {
        const tag = node.name;
        if (tag === 'br') {
          segments.push({ text: '\n', href: null, annotations: { ...parentAnnotations } });
        } else if (tag === 'a') {
          const raw  = $(node).attr('href') || null;
          const href = raw ? resolveUrl(raw) : null;
          const inner = extractRichText(node, parentAnnotations);
          inner.forEach(s => { if (!s.href) s.href = href; });
          segments.push(...inner);
        } else if (tag === 'strong' || tag === 'b') {
          segments.push(...extractRichText(node, { ...parentAnnotations, bold: true }));
        } else if (tag === 'em' || tag === 'i') {
          segments.push(...extractRichText(node, { ...parentAnnotations, italic: true }));
        } else if (tag === 'code' || tag === 'kbd') {
          segments.push(...extractRichText(node, { ...parentAnnotations, code: true }));
        } else if (tag === 's' || tag === 'del' || tag === 'strike') {
          segments.push(...extractRichText(node, { ...parentAnnotations, strikethrough: true }));
        } else if (tag === 'u') {
          segments.push(...extractRichText(node, { ...parentAnnotations, underline: true }));
        } else {
          // span, time, abbr, cite, etc. — inherit parent annotations
          segments.push(...extractRichText(node, parentAnnotations));
        }
      }
    });
    // Filter out whitespace-only segments (but keep newlines)
    return segments.filter(s => s.text === '\n' || s.text.trim().length > 0);
  }

  /** Recursively traverse a DOM node, pushing raw block descriptors into `blocks`. */
  function traverse(node, blocks) {
    if (!node || node.type === 'comment' || node.type === 'directive') return;
    if (node.type === 'text') return; // top-level text nodes carry no block meaning

    const tag = node.name;
    if (!tag || SCRAPE_SKIP_TAGS.has(tag)) return;

    const $el = $(node);

    // ---- Headings ----
    if (tag === 'h1') {
      const t = $el.text().trim();
      if (t) blocks.push({ type: 'heading_1', richText: [{ text: t, href: null, annotations: {} }] });
      return;
    }
    if (tag === 'h2') {
      const t = $el.text().trim();
      if (t) blocks.push({ type: 'heading_2', richText: [{ text: t, href: null, annotations: {} }] });
      return;
    }
    if (tag === 'h3') {
      const t = $el.text().trim();
      if (t) blocks.push({ type: 'heading_3', richText: [{ text: t, href: null, annotations: {} }] });
      return;
    }
    if (tag === 'h4' || tag === 'h5' || tag === 'h6') {
      // Notion only has three heading levels; fold h4-h6 → heading_3
      const t = $el.text().trim();
      if (t) blocks.push({ type: 'heading_3', richText: [{ text: t, href: null, annotations: {} }] });
      return;
    }

    // ---- Paragraph ----
    if (tag === 'p') {
      const richText = extractRichText(node);
      if (richText.some(r => r.text.trim())) {
        blocks.push({ type: 'paragraph', richText });
      }
      return;
    }

    // ---- Image ----
    if (tag === 'img') {
      const src = resolveUrl($el.attr('src') || '');
      // Only external http(s) URLs work in Notion image blocks
      if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
        blocks.push({ type: 'image', url: src });
      }
      return;
    }

    // ---- Lists ----
    if (tag === 'ul') {
      $el.children('li').each((_, li) => {
        const richText = extractRichText(li);
        if (richText.some(r => r.text.trim())) {
          blocks.push({ type: 'bulleted_list_item', richText });
        }
      });
      return;
    }
    if (tag === 'ol') {
      $el.children('li').each((_, li) => {
        const richText = extractRichText(li);
        if (richText.some(r => r.text.trim())) {
          blocks.push({ type: 'numbered_list_item', richText });
        }
      });
      return;
    }

    // ---- Blockquote ----
    if (tag === 'blockquote') {
      const t = $el.text().trim();
      if (t) blocks.push({ type: 'quote', richText: [{ text: t.slice(0, 2000), href: null, annotations: {} }] });
      return;
    }

    // ---- Code block ----
    if (tag === 'pre') {
      const t = $el.text().trim();
      if (t) blocks.push({ type: 'code', text: t });
      return;
    }

    // ---- Divider ----
    if (tag === 'hr') {
      blocks.push({ type: 'divider' });
      return;
    }

    // ---- Container elements — recurse into children ----
    $el.contents().each((_, child) => traverse(child, blocks));
  }

  const blocks = [];
  if (rootNode) {
    $(rootNode).contents().each((_, child) => traverse(child, blocks));
  }

  // Reasonable cap: avoid pathologically large pages grinding Notion's API
  return blocks.slice(0, 500);
}

/**
 * Convert a rich-text segment array to Notion's rich_text format,
 * splitting any segment exceeding Notion's 2 000-char limit.
 */
function toNotionRichText(segments) {
  const result = [];
  for (const { text, href, annotations } of segments) {
    const len = text.length || 1;
    for (let i = 0; i < len; i += 2000) {
      const chunk = text.slice(i, i + 2000) || ' ';
      const obj = { type: 'text', text: { content: chunk } };
      if (href) obj.text.link = { url: href };
      const ann = annotations ?? {};
      if (Object.keys(ann).length > 0) obj.annotations = ann;
      result.push(obj);
    }
  }
  return result.slice(0, 100); // Notion hard limit: 100 rich-text objects per block
}

/**
 * Convert raw block descriptors (from scrapeBlocks) to the Notion API block shape.
 */
function blocksToNotion(rawBlocks) {
  const out = [];
  for (const b of rawBlocks) {
    if (b.type === 'divider') {
      out.push({ type: 'divider', divider: {} });
      continue;
    }
    if (b.type === 'image') {
      out.push({ type: 'image', image: { type: 'external', external: { url: b.url } } });
      continue;
    }
    if (b.type === 'code') {
      const content = (b.text || '').slice(0, 2000);
      out.push({ type: 'code', code: { rich_text: [{ type: 'text', text: { content } }], language: 'plain text' } });
      continue;
    }

    const richText = toNotionRichText(b.richText || []);
    if (!richText.length) continue; // skip blank blocks

    switch (b.type) {
      case 'heading_1':          out.push({ type: 'heading_1',          heading_1:          { rich_text: richText } }); break;
      case 'heading_2':          out.push({ type: 'heading_2',          heading_2:          { rich_text: richText } }); break;
      case 'heading_3':          out.push({ type: 'heading_3',          heading_3:          { rich_text: richText } }); break;
      case 'quote':              out.push({ type: 'quote',              quote:              { rich_text: richText } }); break;
      case 'bulleted_list_item': out.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText } }); break;
      case 'numbered_list_item': out.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: richText } }); break;
      default:                   out.push({ type: 'paragraph',          paragraph:          { rich_text: richText } }); break;
    }
  }
  return out;
}

/**
 * Append Notion blocks to a page, batching into groups of 100 as required by the API.
 */
async function appendBlocksToPage(notion, pageId, notionBlocks) {
  for (let i = 0; i < notionBlocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: notionBlocks.slice(i, i + 100),
    });
  }
}

// ---------------------------------------------------------------------------
// GET /api/ping-notion — verify credentials and database access
// ---------------------------------------------------------------------------
app.get('/api/ping-notion', async (req, res) => {
  const { NOTION_API_KEY, NOTION_DATABASE_ID } = process.env;

  if (!NOTION_API_KEY || NOTION_API_KEY === 'your_notion_api_key_here')
    return res.status(400).json({ success: false, message: 'NOTION_API_KEY is not set. Add it to your .env file.' });
  if (!NOTION_DATABASE_ID || NOTION_DATABASE_ID === 'your_notion_database_id_here')
    return res.status(400).json({ success: false, message: 'NOTION_DATABASE_ID is not set. Add it to your .env file.' });

  try {
    const notion = makeNotionClient();
    const db = await notion.databases.retrieve({ database_id: NOTION_DATABASE_ID });
    const title = db.title?.[0]?.plain_text ?? db.data_sources?.[0]?.name ?? '(untitled)';
    return res.json({ success: true, message: `Connected! Found database: "${title}"` });
  } catch (err) {
    return res.status(err.status ?? 500).json({ success: false, message: notionErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/fetch-title?url=... — extract page title from a URL server-side
// Prefers og:title, falls back to <title>. Stops streaming after </title>.
// ---------------------------------------------------------------------------
app.get('/api/fetch-title', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'url parameter required' });

  try {
    const html = await fetchHtmlChunk(url, { stopAt: /<\/title>/i });
    if (!html) return res.json({ success: true, title: '' });

    const ogMatch =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

    const raw   = ogMatch ? ogMatch[1] : titleMatch ? titleMatch[1] : '';
    const title = decodeHtmlEntities(raw.trim());

    // If the page is gated behind a bot challenge (Cloudflare, etc.) the title
    // will be something like "Just a moment…" — return empty so the user fills
    // it in manually rather than saving a junk title to Notion.
    if (isBotChallenge(html, title)) return res.json({ success: true, title: '' });

    return res.json({ success: true, title });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.name === 'TimeoutError' ? 'Request timed out' : err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/get-tags — return all existing Tags multi-select options from Notion
// ---------------------------------------------------------------------------
app.get('/api/get-tags', async (req, res) => {
  try {
    const notion = makeNotionClient();
    const dataSourceId = await getDataSourceId();
    const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
    const options = ds.properties?.Tags?.multi_select?.options ?? [];
    return res.json({
      success: true,
      tags: options.map((o) => ({ name: o.name, color: o.color ?? 'default' })),
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({ success: false, message: notionErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/summarize?url=... — fetch page content and generate an AI summary
//
// Returns { success: true, summary: "..." } or { success: false, message: "..." }.
// Callers should treat any failure as a soft error and proceed without a summary.
// ---------------------------------------------------------------------------
app.get('/api/summarize', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'url parameter required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_anthropic_api_key_here')
    return res.status(400).json({ success: false, message: 'ANTHROPIC_API_KEY not configured' });

  try {
    // Fetch up to 200 KB of the page — enough for a thorough summary
    const html = await fetchHtmlChunk(url, { maxBytes: 200_000 });
    if (!html) return res.json({ success: false, message: 'Could not fetch page content' });

    // Prefer Readability's clean textContent — it strips nav, ads, and sidebars.
    // Fall back to the regex-based stripHtml for pages Readability can't parse.
    const article = extractArticle(html, url);
    const text = article
      ? article.textContent.replace(/\s+/g, ' ').trim()
      : stripHtml(html);
    if (!text) return res.json({ success: false, message: 'No readable text found on page' });

    const anthropic = new Anthropic({ apiKey });
    const response  = await anthropic.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content:
          'Write a 2–3 sentence summary of the following article. ' +
          'First sentence: what the article is about. ' +
          'Second sentence (optional third): why it\'s worth reading or what the key insight is. ' +
          'Be specific and direct — no filler phrases, no "This article discusses", ' +
          'no "The author explores". Scannable at a glance.\n\n' +
          text.slice(0, 6000),
      }],
    });

    const summary = response.content[0]?.text?.trim() ?? '';
    return res.json({ success: true, summary });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/scrape?url=... — scrape page content and return Notion block descriptors
//
// Useful for debugging the scraping output before it gets written to Notion.
// Returns { success, blockCount, blocks } or { success: false, message }.
// ---------------------------------------------------------------------------
app.get('/api/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'url parameter required' });

  try {
    const html = await fetchHtmlChunk(url, { maxBytes: 500_000 });
    if (!html) return res.json({ success: true, blockCount: 0, blocks: [] });

    if (isBotChallenge(html, '')) {
      return res.json({ success: false, message: 'Page is behind a bot challenge — content cannot be scraped server-side' });
    }

    const article = extractArticle(html, url);
    if (!article) {
      return res.json({ success: false, message: 'Readability could not extract article content — page may be non-article, paywalled, or JS-rendered' });
    }

    const rawBlocks    = scrapeBlocks(article.content, url);
    const notionBlocks = blocksToNotion(rawBlocks);
    return res.json({ success: true, articleTitle: article.title, blockCount: notionBlocks.length, blocks: notionBlocks });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.name === 'TimeoutError' ? 'Request timed out' : err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/save-bookmark — save a new entry to the Notion database
//
// Body: { url, title, tags, summary }
//   tags    — comma-separated string; each becomes a multi_select option
//   summary — AI-generated text; maps to the "Summary" rich_text property
//
// After creating the database page, the handler scrapes the bookmarked URL and
// appends the full article content as Notion blocks to the page body.
// Scraping failures are non-fatal — the bookmark is always saved regardless.
// ---------------------------------------------------------------------------
app.post('/api/save-bookmark', async (req, res) => {
  const { url, title, tags, summary } = req.body;

  if (!url || !url.trim())     return res.status(400).json({ success: false, message: 'URL is required.' });
  if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'Title is required.' });

  const tagList = tags
    ? tags.split(',').map((t) => t.trim()).filter(Boolean).map((name) => ({ name }))
    : [];

  try {
    const notion       = makeNotionClient();
    const dataSourceId = await getDataSourceId();

    // ── Step 1: Create the database entry ────────────────────────────────────
    const page = await notion.pages.create({
      parent: { data_source_id: dataSourceId },
      properties: {
        Title: { title: [{ text: { content: title.trim() } }] },
        URL:   { url: url.trim() },
        ...(tagList.length > 0 && { Tags: { multi_select: tagList } }),
        ...(summary?.trim() && {
          Summary: { rich_text: [{ text: { content: summary.trim() } }] },
        }),
      },
    });

    // ── Step 2: Scrape and write the page body ────────────────────────────────
    // Best-effort — any failure here must not prevent the bookmark from saving.
    try {
      const html = await fetchHtmlChunk(url.trim(), { maxBytes: 500_000 });
      if (html && !isBotChallenge(html, '')) {
        const article = extractArticle(html, url.trim());
        if (article) {
          const rawBlocks    = scrapeBlocks(article.content, url.trim());
          const notionBlocks = blocksToNotion(rawBlocks);
          if (notionBlocks.length > 0) {
            await appendBlocksToPage(notion, page.id, notionBlocks);
          }
        }
      }
    } catch (scrapeErr) {
      console.error('[scrape] Page body could not be written:', scrapeErr.message);
    }

    return res.json({
      success: true,
      message: `Bookmark saved! "${title.trim()}"`,
      pageUrl: page.url,
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({ success: false, message: notionErrorMessage(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
