// Tab Triage — popup logic.
//
// Everything is decided fresh each time the popup opens. The background
// worker only records WHEN tabs were last used; this file turns that into
// KEEP / STASH / DUMP and performs the close/save/restore actions.
//
// The one rule that matters: tabs are SAVED to storage BEFORE they are
// closed, and a saved entry is only removed AFTER its tab exists again.
// Whatever gets interrupted, a tab can end up saved-and-still-open, but
// never gone.

// The 2h/24h windows and the bucketing itself live in triage.js, which
// popup.html loads before this file (background.js shares it too).
const SAVED_CAP = 500; // saved list cap — oldest closedAt dropped first

const BUCKETS = ["keep", "stash", "dump"];
const $ = (sel) => document.querySelector(sel);

let state = { buckets: { keep: [], stash: [], dump: [] }, saved: [] };

// The last close action, for the Undo bar. Lives only in this popup's
// memory on purpose — the bar disappears when the popup closes, while the
// SAVED list underneath it is the durable copy.
let undoBatch = null;

const EMPTY_TEXT = {
  keep: "Nothing here.",
  stash: "Nothing here — nothing idle for 2+ hours.",
  dump: "Nothing here — nothing stale, no duplicates.",
};

init();

async function init() {
  $("#btn-close-stash").addEventListener("click", (e) => { swallow(e); closeBucket("stash"); });
  $("#btn-close-dump").addEventListener("click", (e) => { swallow(e); closeBucket("dump"); });
  $("#btn-undo").addEventListener("click", undoClose);
  $("#btn-restore-all").addEventListener("click", restoreAll);
  $("#btn-clear-saved").addEventListener("click", (e) => clearSaved(e.currentTarget));
  await refresh();
}

// The bucket buttons live inside <summary>; a click's default action there is
// toggling the section, so it has to be swallowed.
function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- sorting --

async function refresh() {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({ currentWindow: true }),
    chrome.storage.local.get(["activity", "saved"]),
  ]);
  const buckets = bucketize(tabs, stored.activity || {}, Date.now());
  state = { buckets, saved: stored.saved || [] };
  render();
}

// -------------------------------------------------------------- rendering --

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  const total = BUCKETS.reduce((n, b) => n + state.buckets[b].length, 0);
  $("#total").textContent = total === 1 ? "1 tab" : total + " tabs";

  for (const name of BUCKETS) {
    const rows = state.buckets[name];
    $("#count-" + name).textContent = rows.length;
    const ul = $("#list-" + name);
    ul.replaceChildren();
    if (!rows.length) {
      ul.append(el("li", "empty", EMPTY_TEXT[name]));
    } else {
      for (const row of rows) ul.append(tabRow(row));
    }
  }
  $("#btn-close-stash").disabled = !state.buckets.stash.length;
  $("#btn-close-dump").disabled = !state.buckets.dump.length;

  renderUndo();
  renderSaved();
}

function tabRow({ tab, why }) {
  const li = el("li", "row");
  li.title = [urlOf(tab), "click to switch to this tab"].filter(Boolean).join(" — ");
  li.append(el("span", "title", (tab.title || "").trim() || domainOf(urlOf(tab)) || "untitled"));
  li.append(el("span", "why", why));
  li.addEventListener("click", async () => {
    await chrome.tabs.update(tab.id, { active: true });
    window.close();
  });
  return li;
}

function renderUndo() {
  const bar = $("#undo-bar");
  if (!undoBatch) {
    bar.hidden = true;
    return;
  }
  const n = undoBatch.entries.length;
  $("#undo-text").textContent = "Closed " + n + (n === 1 ? " tab" : " tabs");
  bar.hidden = false;
}

function renderSaved() {
  const saved = state.saved;
  const now = Date.now();
  $("#count-saved").textContent = saved.length;
  $("#btn-restore-all").disabled = !saved.length;
  $("#btn-clear-saved").disabled = !saved.length;

  const ul = $("#list-saved");
  ul.replaceChildren();
  if (!saved.length) {
    ul.append(el("li", "empty", "Nothing saved yet. Closed tabs land here."));
    return;
  }
  saved.forEach((entry, i) => {
    const li = el("li", "row");
    li.title = entry.url + " — click to reopen";
    li.append(el("span", "title", entry.title || domainOf(entry.url) || "untitled"));
    li.append(el("span", "chip", entry.bucket));
    const when = ago(now - entry.closedAt);
    li.append(el("span", "meta", when === "now" ? "just now" : when + " ago"));
    const x = el("button", "x", "×");
    x.title = "Forget this one (does not reopen it)";
    x.addEventListener("click", (e) => { e.stopPropagation(); forgetSaved(i); });
    li.append(x);
    li.addEventListener("click", () => restoreOne(i));
    ul.append(li);
  });
}

// ---------------------------------------------------------------- actions --

async function closeBucket(name) {
  const rows = state.buckets[name];
  if (!rows.length) return;

  // SAVE FIRST, CLOSE SECOND — this ordering is the whole product guarantee.
  // If the popup dies between the two steps (user clicks away mid-action),
  // the worst case is tabs that are saved AND still open — never lost.
  const now = Date.now();
  const entries = rows.map(({ tab }) => ({
    url: urlOf(tab),
    title: (tab.title || "").trim(),
    pinned: !!tab.pinned,
    bucket: name,
    closedAt: now,
  }));
  const stored = await chrome.storage.local.get("saved");
  const saved = [...entries, ...(stored.saved || [])].slice(0, SAVED_CAP);
  await chrome.storage.local.set({ saved });

  // Arm the Undo bar for exactly this batch. All entries in a batch share
  // the same closedAt stamp, which is how undo finds them in SAVED later.
  undoBatch = { stamp: now, entries };

  try {
    await chrome.tabs.remove(rows.map(({ tab }) => tab.id));
  } catch {
    // Some tab vanished between query and close — fine, the rest closed.
  }
  await refresh();
}

async function undoClose() {
  if (!undoBatch) return;
  const { stamp, entries } = undoBatch;
  // Same rule as restore: reopen FIRST, only then drop the saved records.
  const reopened = new Set();
  for (const entry of entries) {
    try {
      await chrome.tabs.create({ url: entry.url, pinned: entry.pinned, active: false });
      reopened.add(entry.url);
    } catch {
      // Unopenable URL: its entry stays in SAVED rather than vanishing.
    }
  }
  const stored = await chrome.storage.local.get("saved");
  const saved = (stored.saved || []).filter(
    (e) => !(e.closedAt === stamp && reopened.has(e.url))
  );
  await chrome.storage.local.set({ saved });
  undoBatch = null;
  await refresh();
}

async function restoreOne(index) {
  const stored = await chrome.storage.local.get("saved");
  const saved = stored.saved || [];
  const entry = saved[index];
  if (!entry) return;
  // Mirror of the close guarantee: reopen FIRST, only then drop the record.
  await chrome.tabs.create({ url: entry.url, pinned: entry.pinned, active: false });
  saved.splice(index, 1);
  await chrome.storage.local.set({ saved });
  await refresh();
}

async function restoreAll() {
  const stored = await chrome.storage.local.get("saved");
  const saved = stored.saved || [];
  const failed = [];
  for (const entry of saved) {
    try {
      await chrome.tabs.create({ url: entry.url, pinned: entry.pinned, active: false });
    } catch {
      failed.push(entry); // an unopenable URL stays saved rather than vanishing
    }
  }
  await chrome.storage.local.set({ saved: failed });
  await refresh();
}

async function forgetSaved(index) {
  const stored = await chrome.storage.local.get("saved");
  const saved = stored.saved || [];
  saved.splice(index, 1);
  await chrome.storage.local.set({ saved });
  await refresh();
}

function clearSaved(btn) {
  // Two-click confirm; window.confirm() is unreliable in extension popups
  // (the dialog can steal focus and close the popup underneath itself).
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    btn.textContent = "Clear";
    chrome.storage.local.set({ saved: [] }).then(refresh);
  } else {
    btn.dataset.armed = "1";
    btn.textContent = "Really clear?";
    setTimeout(() => {
      if (btn.dataset.armed) {
        delete btn.dataset.armed;
        btn.textContent = "Clear";
      }
    }, 2500);
  }
}
