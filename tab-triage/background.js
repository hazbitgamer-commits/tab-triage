// Tab Triage — background service worker.
//
// Its only job is to record WHEN each tab was last actually used, into
// chrome.storage.local under the "activity" key ({ tabId: epochMillis }).
// All sorting/closing decisions happen in the popup.
//
// MV3 SERVICE WORKER LIFECYCLE — the non-obvious parts:
//
// 1. This worker is ephemeral. Chrome starts it when an event fires and kills
//    it after ~30 seconds of idle. Every JS variable evaporates on each kill,
//    so the only durable state is chrome.storage. Never cache the activity
//    map in a module variable and expect it to survive to the next event.
//
// 2. Event listeners must be registered synchronously at the top level of
//    this file. When Chrome wakes a dead worker for an event, it re-runs the
//    top-level code and then dispatches the event; a listener added inside an
//    async callback or after an `await` can miss the very event that caused
//    the wake-up.
//
// 3. Tab IDs are NOT stable across browser restarts. An id recorded today can
//    belong to a completely different tab tomorrow, so onStartup rebuilds the
//    whole map from Chrome's own `tab.lastAccessed` and discards stale ids.
//
// 4. Events arrive in bursts (restoring a window fires dozens of
//    onActivated/onUpdated almost at once) and every handler does an async
//    read-modify-write on storage. Interleaved, they would overwrite each
//    other, so all writes go through one promise chain (`writeQueue`). The
//    chain itself dies with the worker, which is fine — a dead worker has no
//    in-flight handlers left to race with.
//
// 5. importScripts() must run synchronously at the top level, like the
//    listeners in note 2 — MV3 rejects it once initial evaluation finishes.
//    And setTimeout here is best-effort: if Chrome kills the worker first,
//    the timer silently dies. That's acceptable for the badge debounce
//    below, because any later tab event schedules a fresh update.

importScripts("triage.js");

const ACTIVITY_KEY = "activity";

let writeQueue = Promise.resolve();

function stamp(mutate) {
  writeQueue = writeQueue
    .then(async () => {
      const stored = await chrome.storage.local.get(ACTIVITY_KEY);
      const activity = stored[ACTIVITY_KEY] || {};
      mutate(activity);
      await chrome.storage.local.set({ [ACTIVITY_KEY]: activity });
      scheduleBadgeUpdate(); // activity changed, so the DUMP count may have
    })
    .catch(() => {}); // one failed write must not wedge the chain forever
  return writeQueue;
}

// ------------------------------------------------------------------ badge --
// The toolbar icon shows how many tabs are ready to DUMP; empty text hides
// the badge. Event-driven only (created/closed/activated/navigated + browser
// start): a periodic timer would need the "alarms" permission, and staying
// at tabs+storage matters more. A tab that crosses the 24h line therefore
// shows up in the count on the next tab event, which in practice is the
// next time you touch the browser.

let badgeTimer = null;

function scheduleBadgeUpdate() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    updateBadge();
  }, 150); // collapse event bursts; see lifecycle note 5
}

async function updateBadge() {
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get(ACTIVITY_KEY),
  ]);
  const activity = stored[ACTIVITY_KEY] || {};
  const now = Date.now();
  // Count per window, matching what each window's popup would show —
  // duplicates are judged within a window, not across all of Chrome.
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  let dump = 0;
  for (const group of byWindow.values()) {
    dump += bucketize(group, activity, now).dump.length;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#8a8f98" });
  await chrome.action.setBadgeText({ text: dump ? String(dump) : "" });
}

// Rebuild the map from scratch: one entry per open tab, seeded from Chrome's
// own last-accessed time. Runs on install (so the extension is useful
// immediately, not "everything is new" for 2 hours) and on every browser
// start (lifecycle note 3).
async function reseed() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const activity = {};
  for (const tab of tabs) {
    activity[tab.id] = tab.lastAccessed || now;
  }
  await chrome.storage.local.set({ [ACTIVITY_KEY]: activity });
}

chrome.runtime.onInstalled.addListener(() => {
  reseed().then(updateBadge);
});

chrome.runtime.onStartup.addListener(() => {
  reseed().then(updateBadge);
});

// A tab appearing can change the DUMP count (it may be a duplicate).
chrome.tabs.onCreated.addListener(() => {
  scheduleBadgeUpdate();
});

// Switching to a tab counts as using it.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  stamp((activity) => {
    activity[tabId] = Date.now();
  });
});

// Navigating counts as using it — but only in the tab you are looking at.
// Background tabs that reload themselves (news sites, dashboards) must NOT
// count as "used", or they would sit in KEEP forever.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === "loading")) {
    stamp((activity) => {
      activity[tabId] = Date.now();
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stamp((activity) => {
    delete activity[tabId];
  });
});
