// All API calls go to the local Express server
const API_BASE = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let existingTags   = [];        // { name, color } from Notion
let selectedTags   = new Set(); // names currently toggled on
let customTags     = [];        // names typed by user, not in existingTags
let summaryPromise = null;      // Promise<string> — resolves to AI summary or ''

// Notion color name → CSS { bg, text } tokens
const TAG_PALETTE = {
  default: { bg: '#f0f0f0', text: '#555' },
  gray:    { bg: '#f3f4f6', text: '#6b7280' },
  brown:   { bg: '#fdf3ee', text: '#92400e' },
  orange:  { bg: '#fff7ed', text: '#c2410c' },
  yellow:  { bg: '#fefce8', text: '#a16207' },
  green:   { bg: '#f0fdf4', text: '#166534' },
  blue:    { bg: '#eff6ff', text: '#1d4ed8' },
  purple:  { bg: '#faf5ff', text: '#7c3aed' },
  pink:    { bg: '#fdf2f8', text: '#9d174d' },
  red:     { bg: '#fef2f2', text: '#b91c1c' },
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  loadTags();
  loadFromActiveTab();
  loadDatabaseName();
  setupTagInput();
  setupUrlBlur();
  setupFormHandlers();
});

// ---------------------------------------------------------------------------
// Database name — shown in the footer so users can confirm the right database
// ---------------------------------------------------------------------------
async function loadDatabaseName() {
  try {
    const res  = await fetch(`${API_BASE}/api/get-database-name`);
    const data = await res.json();
    if (data.success && data.name) {
      document.getElementById('dbName').textContent = data.name;
    }
  } catch { /* leave as ellipsis if server unreachable */ }
}

// ---------------------------------------------------------------------------
// Active tab auto-fill (replaces clipboard check from the web UI)
// ---------------------------------------------------------------------------
async function loadFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const urlInput   = document.getElementById('url');
    const titleInput = document.getElementById('title');

    if (tab.url && isValidUrl(tab.url) && !urlInput.value) {
      urlInput.value = tab.url;
      document.getElementById('autofillBadge').style.display = 'inline';
      startSummarize(tab.url);
    }

    // The browser already has the rendered title — use it directly.
    // No need for a server-side /api/fetch-title round-trip.
    if (tab.title && !titleInput.value) {
      titleInput.value = tab.title;
    }
  } catch {
    // tabs API unavailable (e.g. extension loaded on chrome:// pages) — ignore
  }
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
async function loadTags() {
  try {
    const res  = await fetch(`${API_BASE}/api/get-tags`);
    const data = await res.json();
    if (data.success) existingTags = data.tags;
  } catch { /* silently degrade */ }
  finally {
    document.getElementById('tagsLoading').style.display = 'none';
    document.getElementById('tagInput').style.display   = 'block';
    renderTagChips();
  }
}

function renderTagChips() {
  // Existing Notion tags — no inline onclick; event delegation handles clicks
  const container = document.getElementById('tagChips');
  container.innerHTML = existingTags.map(tag => {
    const palette  = TAG_PALETTE[tag.color] ?? TAG_PALETTE.default;
    const selected = selectedTags.has(tag.name);
    return `<button
      type="button"
      class="tag-chip${selected ? ' selected' : ''}"
      style="background:${palette.bg};color:${palette.text}"
      aria-pressed="${selected}"
      data-name="${escHtml(tag.name)}"
    >${escHtml(tag.name)}</button>`;
  }).join('');

  // Custom (new) tags
  const custom = document.getElementById('customTagChips');
  custom.innerHTML = customTags.map(name =>
    `<span class="tag-chip custom">
      ${escHtml(name)}
      <button type="button" class="tag-remove" data-name="${escHtml(name)}" title="Remove">×</button>
    </span>`
  ).join('');
}

function toggleTag(name) {
  if (selectedTags.has(name)) selectedTags.delete(name);
  else selectedTags.add(name);
  renderTagChips();
}

function addCustomTag(raw) {
  const name = raw.trim().replace(/,+$/, '').trim();
  if (!name) return;
  // If it matches an existing tag, just select that chip instead
  const existing = existingTags.find(
    t => t.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    selectedTags.add(existing.name);
  } else if (!customTags.includes(name)) {
    customTags.push(name);
  }
  renderTagChips();
}

function removeCustomTag(name) {
  customTags = customTags.filter(t => t !== name);
  renderTagChips();
}

function setupTagInput() {
  const input = document.getElementById('tagInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addCustomTag(input.value);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && customTags.length > 0) {
      removeCustomTag(customTags[customTags.length - 1]);
    }
  });
  // Handle paste of comma-separated tags
  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      input.value.split(',').forEach(t => addCustomTag(t));
      input.value = '';
    }
  });
}

function getTagsString() {
  return [...selectedTags, ...customTags].join(', ');
}

// ---------------------------------------------------------------------------
// Summary — fire-and-forget background request
// ---------------------------------------------------------------------------
function startSummarize(url) {
  summaryPromise = fetch(`${API_BASE}/api/summarize?url=${encodeURIComponent(url)}`)
    .then(r => r.json())
    .then(d => (d.success ? d.summary : ''))
    .catch(() => '');
}

// ---------------------------------------------------------------------------
// Title fetch — used when the user manually types or edits the URL field.
// (Not needed for auto-fill from tab since tab.title is already available.)
// ---------------------------------------------------------------------------
async function autoFetchTitle(url) {
  const titleInput = document.getElementById('title');
  const spinner    = document.getElementById('titleSpinner');
  const hint       = document.getElementById('titleFetchHint');

  if (titleInput.value) return; // don't overwrite user-entered title

  spinner.classList.remove('hidden');
  hint.style.display = 'inline';

  try {
    const res  = await fetch(`${API_BASE}/api/fetch-title?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (data.success && data.title && !titleInput.value) {
      titleInput.value = data.title;
    }
  } catch { /* leave title blank */ }
  finally {
    spinner.classList.add('hidden');
    hint.style.display = 'none';
  }
}

// Re-fetch title when user leaves the URL field (only if title is still empty);
// also (re-)start the background summarise whenever the URL changes.
function setupUrlBlur() {
  const urlInput = document.getElementById('url');
  urlInput.addEventListener('blur', e => {
    const url = e.target.value.trim();
    if (url && isValidUrl(url)) {
      autoFetchTitle(url);
      startSummarize(url);
    }
  });
  // Hide "from tab" badge if the user edits the URL manually
  urlInput.addEventListener('input', () => {
    document.getElementById('autofillBadge').style.display = 'none';
  });
}

// ---------------------------------------------------------------------------
// Event wiring (no inline handlers — required by MV3 CSP)
// ---------------------------------------------------------------------------
function setupFormHandlers() {
  document.getElementById('bookmarkForm').addEventListener('submit', saveBookmark);
  document.getElementById('pingBtn').addEventListener('click', pingNotion);

  // Clicking anywhere in the tags wrapper focuses the text input
  document.getElementById('tagsWrapper').addEventListener('click', e => {
    if (!e.target.closest('.tag-chip') && !e.target.closest('.tag-remove')) {
      document.getElementById('tagInput').focus();
    }
  });

  // Event delegation: existing tag chips
  document.getElementById('tagChips').addEventListener('click', e => {
    const btn = e.target.closest('button[data-name]');
    if (btn) toggleTag(btn.dataset.name);
  });

  // Event delegation: custom tag remove buttons
  document.getElementById('customTagChips').addEventListener('click', e => {
    const btn = e.target.closest('.tag-remove');
    if (btn) removeCustomTag(btn.dataset.name);
  });
}

// ---------------------------------------------------------------------------
// Form save
// ---------------------------------------------------------------------------
async function saveBookmark(event) {
  event.preventDefault();

  const btn   = document.getElementById('submitBtn');
  const url   = document.getElementById('url').value.trim();
  const title = document.getElementById('title').value.trim();
  const tags  = getTagsString();

  if (!url)   return showStatus('error', 'Missing field', 'URL is required.');
  if (!title) return showStatus('error', 'Missing field', 'Title is required.');

  btn.disabled    = true;
  btn.textContent = 'Saving…';
  document.getElementById('status').style.display = 'none';

  // Collect whatever summary the background fetch has produced.
  // Wait up to 3 s; if it isn't ready (or failed) just proceed without it.
  let summary = '';
  if (summaryPromise) {
    const timeout = new Promise(resolve => setTimeout(() => resolve(''), 3000));
    summary = await Promise.race([summaryPromise, timeout]) ?? '';
  }

  try {
    const res  = await fetch(`${API_BASE}/api/save-bookmark`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, title, tags, summary }),
    });
    const data = await res.json();

    if (data.success) {
      showStatus('success', 'Saved!', data.message, data.pageUrl);
      resetForm();
    } else {
      showStatus('error', 'Save failed', data.message);
    }
  } catch {
    showStatus('error', 'Request failed', 'Could not reach the server. Is it running on port 3000?');
  }

  btn.disabled    = false;
  btn.textContent = 'Save Bookmark';
}

function resetForm() {
  document.getElementById('url').value   = '';
  document.getElementById('title').value = '';
  document.getElementById('autofillBadge').style.display = 'none';
  summaryPromise = null;
  selectedTags.clear();
  customTags = [];
  renderTagChips();
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------
async function pingNotion() {
  document.getElementById('status').style.display = 'none';
  try {
    const res  = await fetch(`${API_BASE}/api/ping-notion`);
    const data = await res.json();
    showStatus(
      data.success ? 'success' : 'error',
      data.success ? 'Connection OK' : 'Connection failed',
      data.message
    );
  } catch {
    showStatus('error', 'Request failed', 'Could not reach the server. Is it running on port 3000?');
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function showStatus(type, label, message, link) {
  const el = document.getElementById('status');
  el.className     = type;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="status-label">${escHtml(label)}</div>
    <div>${escHtml(message)}</div>
    ${link ? `<a href="${escHtml(link)}" target="_blank" rel="noopener">Open in Notion →</a>` : ''}
  `;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function isValidUrl(text) {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
