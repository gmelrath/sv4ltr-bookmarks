# Bookmark to Notion

A Chrome extension for saving bookmarks to a Notion database. The extension reads the active tab's URL and title automatically, then saves to Notion with AI-generated summary and full article body in one click. The extension talks to a local Express backend — both must be running at the same time.

---

## Setup Guide

### Step 1 — Create a Notion Integration

Notion requires you to create an "integration" (basically an API app) to let external programs write to your workspace.

1. Go to **https://www.notion.so/my-integrations** (you must be logged in).
2. Click **"New integration"**.
3. Fill in the form:
   - **Name**: Something like `Bookmark Saver`
   - **Associated workspace**: Select your workspace
   - **Type**: Leave as "Internal"
4. Under **"Capabilities"**, make sure these are checked:
   - Read content
   - Update content
   - Insert content
5. Click **"Save"**.
6. You'll land on a page showing your integration. Click **"Show"** next to **Internal Integration Secret**, then copy the token — it starts with `ntn_...` or `secret_...`.

This token is your `NOTION_API_KEY`.

---

### Step 2 — Find Your Database ID

Your Notion database already exists. You need to get its ID from the URL.

1. Open your bookmarks database in Notion (the one with URL, Title, Tags, and Summary fields).
2. If it's embedded in a page, click the `↗` icon in the top-right of the database to open it as a full page.
3. Look at the URL in your browser. It will look like one of these:

   ```
   https://www.notion.so/myworkspace/My-Bookmarks-abc123def456abc123def456abc123de
                                     ^--- this whole last part is the database ID

   https://www.notion.so/abc123def456abc123def456abc123de?v=...
                          ^--- everything before the ? is the database ID
   ```

4. Copy the 32-character ID (just the hex string, no dashes required — Notion accepts both formats).

This is your `NOTION_DATABASE_ID`.

> **Tip:** The ID is always a 32-character string made of letters and numbers, like `abc123def456abc123def456abc123de`. If you see a `?v=` in the URL, everything after that is the *view* ID — you don't need it.

---

### Step 3 — Connect the Integration to Your Database

This is the step most people miss. Even with a valid API key, Notion blocks access unless you explicitly share the database with your integration.

1. Open your bookmarks database in Notion.
2. Click the **"..."** menu (three dots) in the top-right corner of the page.
3. Click **"Connections"** (you may see it labeled "Add connections" or "Connect to").
4. Search for the integration name you created (e.g., `Bookmark Saver`) and select it.
5. Confirm when prompted.

Your integration now has access to this database.

---

### Step 4 — Configure Your `.env` File

> `.env` is a hidden file — toggle hidden files in Finder with `Cmd + Shift + .`, or open it directly with `open -e .env`.

Open `.env` and replace the placeholder values:

```
NOTION_API_KEY=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=abc123def456abc123def456abc123de
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Do not add quotes around the values.

**`ANTHROPIC_API_KEY` is optional.** If omitted (or left as the placeholder), the AI summary feature is silently skipped and bookmarks are saved without a Summary. Get a key at **https://console.anthropic.com** → API Keys.

---

### Step 5 — Install Dependencies and Start the Server

```bash
cd bookmark-to-notion
npm install
npm start
```

The server starts at **http://localhost:3000** and must keep running in the background while you use the extension.

---

### Step 6 — Load the Chrome Extension

1. Open Chrome and navigate to **chrome://extensions**
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the **`extension/`** folder inside this project directory

The extension icon will appear in your Chrome toolbar. Pin it for easy access.

> **The Express server must be running (`npm start`) for the extension to work.** The extension is a frontend only — it has no backend of its own.

---

### Step 7 — Save a Bookmark

Navigate to any article or page you want to bookmark, then click the extension icon. The popup opens with the form pre-filled:

- **URL** — automatically populated from the active tab. No clipboard reading needed.
- **Title** — automatically populated from the tab title (the browser's already-rendered value). Editable.
- **Tags** — all existing Tags from your Notion database are shown as color-coded chips. Click to select/deselect. Type a new tag in the input and press **Enter** to add it (if it matches an existing tag it selects that chip; otherwise it creates a new option in Notion on save).

An **AI summary** is generated silently in the background as soon as the popup opens (requires `ANTHROPIC_API_KEY`). It is saved to the **Summary** field in Notion automatically — no user action needed. If summarisation fails (paywalled page, slow network, missing API key), the bookmark is saved without a summary.

When you click **Save Bookmark**, the server extracts the full article content using `@mozilla/readability` and writes it into the body of the newly created Notion page. Readability isolates the main article body, automatically stripping navigation, ads, sidebars, footers, and related-article sections. The cleaned content is then mapped to native Notion block types: headings, paragraphs with inline links, images, lists, blockquotes, and code blocks. If the page is behind a bot-challenge (Cloudflare, etc.), is paywalled, is a non-article page, or Readability returns a low-confidence result, the bookmark and summary are still saved; only the page body is skipped.

On success, a green confirmation banner appears with an **"Open in Notion →"** link.

---

## Field Mapping

| Source | Notion property | Type |
|---|---|---|
| URL field | URL | url |
| Title field | Title | title |
| Tags chips | Tags | multi_select |
| AI summary (background) | Summary | rich_text |

---

## Troubleshooting

| Error | Likely cause |
|---|---|
| `NOTION_API_KEY is not set` | `.env` file not saved or not in the project folder |
| `Invalid API key` | Token was copied incorrectly |
| `Database not found` | Wrong database ID, or Step 3 (connecting the integration) was skipped |
| `Notion rejected the request` | A field value doesn't match the expected type — check the Notion property types match the table above |
| Title not auto-filling | The page blocks scrapers or requires JavaScript to render. Fill it in manually. |
| Summary not appearing in Notion | `ANTHROPIC_API_KEY` not set, page is paywalled, or summarisation timed out — bookmark is saved anyway |
| Page body empty in Notion | Page is bot-gated (Cloudflare), paywalled, or requires JavaScript — properties are still saved |

---

## Project Structure

```
bookmark-to-notion/
├── server.js           # Express server — all API endpoints
├── index.html          # Legacy web UI (kept for reference; extension is the primary interface)
├── extension/
│   ├── manifest.json   # Chrome Manifest V3
│   ├── popup.html      # Extension popup markup
│   ├── popup.css       # Extension popup styles
│   └── popup.js        # Extension popup logic
├── .env                # Your secrets (never commit this)
├── .gitignore          # Excludes .env and node_modules
└── README.md           # This file
```

## Available Scripts

| Command | Description |
|---|---|
| `npm start` | Start the server |
| `node --watch server.js` | Start with auto-reload on file changes (Node 18+) |

## API Endpoints

| Endpoint | Method | Body / Params | Description |
|---|---|---|---|
| `/api/ping-notion` | GET | — | Tests credentials and database access |
| `/api/get-tags` | GET | — | Returns all Tags multi-select options from Notion |
| `/api/fetch-title` | GET | `?url=` | Fetches og:title / `<title>` from a URL server-side |
| `/api/summarize` | GET | `?url=` | Extracts article text via Readability and returns a scannable 2–3 sentence summary: what the article covers + why it's worth reading |
| `/api/scrape` | GET | `?url=` | Scrapes page content and returns Notion block descriptors (for debugging) |
| `/api/save-bookmark` | POST | `{ url, title, tags, summary }` | Creates a Notion database entry and writes the full article body to the page |

## Dependencies & Notable Quirks

- **`@notionhq/client` v5** — major breaking change from v2. Schema is exposed via `dataSources.retrieve()` (not `databases.retrieve()`). Pages must be created with `parent: { data_source_id }` resolved from `databases.retrieve().data_sources[0].id`. The `data_source_id` is resolved once on first request and cached.
- **`dotenv` v17** — rebranded as dotenvx. `require('dotenv').config()` still works; the log line on startup is expected.
- **`express` v5** — async errors in route handlers are caught automatically.
- **`@anthropic-ai/sdk` v0.x** — `require('@anthropic-ai/sdk')` returns the constructor directly (not `.default`). Model used: `claude-haiku-4-5`. Max 300 output tokens; up to 6 000 characters of page text sent as context.
- **`/api/fetch-title` / `/api/summarize`** — both use Node's built-in `https`/`http` modules with `rejectUnauthorized: false` scoped to those functions only, so title/summary fetching works on corporate networks and non-standard SSL environments without affecting Notion API calls.
- **Silent summarisation** — the frontend fires `/api/summarize` in the background immediately after a URL is entered. `saveBookmark` waits up to 3 seconds for the result before POSTing; if the summary isn't ready or fails it is omitted and the bookmark is saved normally.
- **`@mozilla/readability` + `jsdom`** — used in `/api/scrape`, `/api/save-bookmark`, and `/api/summarize` to isolate main article content from raw page HTML. Readability strips nav, ads, sidebars, and related-article sections before any further processing. Results with fewer than 200 extracted characters are treated as low-confidence and discarded (page body skipped; summary falls back to regex-based extraction).
- **`cheerio`** — parses Readability's clean article HTML into Notion block descriptors. Headings map to `heading_1/2/3`, paragraphs to `paragraph`, `<ul>`/`<ol>` to list items, `<blockquote>` to quote, `<pre>` to code, `<img>` to external image blocks. Inline `<a>` links, bold, italic, code, strikethrough, and underline are preserved as rich-text annotations.
- **100-block batching** — Notion's API limits `blocks.children.append` to 100 children per call. Content is automatically split into sequential batches. Total block output is capped at 500 to avoid pathologically large articles.
- **Non-fatal extraction** — all content extraction and page-body writing happens after the Notion page is created. Any failure (network error, bot-challenge, low-confidence Readability result, timeout) is caught, logged to the server console, and silently ignored so the bookmark is always saved.
