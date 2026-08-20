// Tab Triage — shared bucketing rules. The single source of truth.
//
// Loaded by popup.html as a plain <script> (before popup.js) and by
// background.js via importScripts(), so the toolbar badge and the popup
// count DUMP with exactly the same rules and can never disagree.
// Plain script on purpose: no modules, no build step, no manifest changes.

const HOUR = 60 * 60 * 1000;
const KEEP_WINDOW = 2 * HOUR;   // used more recently than this  -> KEEP
const DUMP_WINDOW = 24 * HOUR;  // untouched longer than this    -> DUMP

function urlOf(tab) {
  return tab.url || tab.pendingUrl || "";
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

function idleLabel(age) {
  const a = ago(age);
  return a === "now" ? "just used" : a + " idle";
}

// Sort tabs into { keep, stash, dump } rows of { tab, used, age, why }.
function bucketize(tabs, activity, now) {
  // Last-used = the later of what the background worker recorded and what
  // Chrome itself reports. Ties break toward "more recent" on purpose: when
  // in doubt a tab counts as used, which keeps it away from DUMP.
  const lastUsed = (tab) =>
    Math.max(activity[tab.id] || 0, tab.lastAccessed || 0) || now;

  // The most recently used copy of each URL is the "real" one; every other
  // copy is a duplicate.
  const canonical = new Map();
  for (const tab of tabs) {
    const url = urlOf(tab);
    const cur = canonical.get(url);
    if (!cur || lastUsed(tab) > lastUsed(cur)) canonical.set(url, tab);
  }

  const buckets = { keep: [], stash: [], dump: [] };
  for (const tab of tabs) {
    const used = lastUsed(tab);
    const row = { tab, used, age: now - used, why: "" };
    // Every row carries the reason it was bucketed, shown in the popup.
    // Pinned, audible and the current tab are always KEEP — nothing the
    // buttons close can ever include them, duplicates or not.
    if (tab.pinned) {
      row.why = "pinned";
      buckets.keep.push(row);
    } else if (tab.audible) {
      row.why = "playing audio";
      buckets.keep.push(row);
    } else if (tab.active) {
      row.why = "current tab";
      buckets.keep.push(row);
    } else if (canonical.get(urlOf(tab)) !== tab) {
      row.why = "duplicate";
      buckets.dump.push(row);
    } else if (row.age < KEEP_WINDOW) {
      row.why = idleLabel(row.age);
      buckets.keep.push(row);
    } else if (row.age >= DUMP_WINDOW) {
      row.why = idleLabel(row.age);
      buckets.dump.push(row);
    } else {
      row.why = idleLabel(row.age);
      buckets.stash.push(row);
    }
  }

  // KEEP stays in tab-strip order; STASH and DUMP list oldest first.
  buckets.stash.sort((a, b) => a.used - b.used);
  buckets.dump.sort((a, b) => a.used - b.used);
  return buckets;
}
