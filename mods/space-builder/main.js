// Build a space, its tabs and its panes from a centralized JSON config.
//
// Configurations come from one file. The default is
// ~/.config/herdr-app/spaces.json; Configuration in the footer can point the
// mod at another folder, and that choice is remembered.
//
// A pane is { id, command?, working_dir?, split_from?, split? }. The first
// pane without split_from is the tab's root. The others split that pane's
// region. An omitted `working_dir` inherits the tab root; the root uses Herdr defaults. `command`
// empty/null leaves a plain shell. Split sizes are the app's own; the config
// does not set them (Herdr has no pane-resize command).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  props, closeOverlay, theme, exec, hc, readTextFile, appHome, home,
  spaces, panes, machines, focused, keys, shared, setShared, notify, pickFolder, nextCommand,
} from "herdr";

import { validate, parseConfigs, norm, pathKey, absolute, targetOf, nameOf, spaceKey, hasDirectory } from "./config.js";

const CONFIG_NAME = "spaces.json";
const CONFIG_KEY = "space-builder.config";
const STATE = "space-builder.operations";
const RESERVATION_TTL = 60000;
const RESERVATION_REFRESH = 20000;
const LOADING_STATUS = "Loading the space…";
const HOMES = new Map();
const ENTRY_H = 46;
const ROW_GAP = 6;
const LIST_MAX_H = 420;
const SEARCH_ICON = "mods/workspace-chrome/search.svg";
const SERVER_ICON = "mods/workspace-chrome/server.svg";
const FILE_ICON = "mods/workspace-chrome/file-text.svg";
const X_ICON = "mods/workspace-chrome/x.svg";
const SETTINGS_ICON = "mods/workspace-chrome/settings.svg";

const tint = (color, alpha) => {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color ?? "");
  if (!match) return color;
  const opacity = match[2] ? parseInt(match[2], 16) : 255;
  return `#${match[1]}${Math.round(opacity * alpha).toString(16).padStart(2, "0")}`;
};
const joinPath = (dir, name) => `${String(dir).replace(/[\\/]+$/, "")}/${name}`;
const defaultConfigPath = () => joinPath(appHome(), CONFIG_NAME);

function storedConfigPath() {
  const saved = shared(CONFIG_KEY);
  return typeof saved === "string" && saved.trim() ? saved : defaultConfigPath();
}

function machineInfo(target) {
  const machine = machines().find((m) => m.name === (target ?? null));
  const label = target || "local";
  if (!machine) return { ok: false, label: target ? `machine "${target}" not configured` : "local layout unavailable" };
  return { ok: machine.layout === "ready", label: machine.layout === "ready" ? label : `${label} ${machine.layout}` };
}
const machineReady = (name) => machineInfo(name).ok;
function validateMachine(target) {
  const info = machineInfo(target);
  if (!info.ok) throw new Error(info.label);
}

function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
const psq = (value) => "'" + String(value).replace(/'/g, "''") + "'";

// Try the native Windows shells only when sh could not be launched. Never
// interpret transport/start errors as successful validation or as a local home.
async function shellProbe(script, windowsScript, on) {
  let failure;
  try { return await exec("sh", ["-c", script], { on }); }
  catch (e) { failure = e; }
  for (const shell of ["pwsh", "powershell"]) {
    try { return await exec(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsScript], { on }); }
    catch (e) { failure = e; }
  }
  throw new Error(`Could not inspect ${on || "local"} paths: ${failure?.message ?? failure}`);
}

async function homeOn(on) {
  if (!on) return home();
  const cached = HOMES.get(on);
  if (cached && Date.now() - cached.at < 60000) return cached.path;
  const r = await shellProbe('printf %s "$HOME"', '[Console]::Write($HOME)', on);
  const path = r.stdout.trim();
  if (r.code !== 0 || !path || !absolute(path)) throw new Error(`Could not read the home directory on ${on}.`);
  HOMES.set(on, { path, at: Date.now() });
  return path;
}

async function expand(path, root, on) {
  if (path == null || path === "") return norm(root);
  if (path === "~" || /^~[\\/]/.test(path)) return norm((await homeOn(on)) + path.slice(1));
  if (path.startsWith("~")) throw new Error(`Unsupported home path: ${path}. Use ~ or ~/folder.`);
  if (absolute(path)) return norm(path);
  return norm(`${root}/${path}`);
}

async function cli(name, args = {}) {
  // Flag values are parsed as JSON by the CLI. One JSON object preserves
  // strings such as "123", "true", and "null", and omits undefined fields.
  const r = await exec("herdr-app", ["do", name, JSON.stringify(args)]);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  if (r.code !== 0 || out?.error) {
    throw new Error(out?.error || r.stderr?.trim() || `herdr-app ${name} failed`);
  }
  return out ?? {};
}

async function paneFor(terminal, cx) {
  for (let i = 0; i < 60; i++) {
    const pane = panes().find((p) => p.terminal === terminal);
    if (pane) return pane.pane;
    await cx.sleep(20);
  }
  throw new Error(`The pane for ${terminal} did not appear`);
}

function withCd(command, from, to, shell = "") {
  const text = command || "";
  const body = text.split(/\r?\n/).every((line) => !line.trim() || line.trim().startsWith("#")) ? "" : text;
  if (!to || pathKey(from) === pathKey(to)) return body;
  if (/^(pwsh|powershell)(\.exe)?$/i.test(shell)) {
    const cd = `Set-Location -LiteralPath ${psq(to)} -ErrorAction Stop`;
    return body ? `${cd}; if ($?) { ${body}\n}` : cd;
  }
  const cd = `cd ${shq(to)}`;
  return body ? `${cd} && ${body}` : cd;
}

class Cancelled extends Error {
  constructor() { super("Space build cancelled."); this.name = "Cancelled"; }
}

async function send(terminal, command, cx, check = () => {}) {
  if (!command) return;
  // The app exposes no prompt-ready signal for arbitrary shells. Wait for the
  // terminal's shell to appear instead of assuming pane creation implies it.
  let shell;
  for (let i = 0; i < 100; i++) {
    check();
    const pane = panes().find((p) => p.terminal === terminal);
    if (pane?.program?.shell && !pane.program.agent && !pane.status) { shell = pane; break; }
    await cx.sleep(50);
  }
  if (!shell) throw new Error(`The shell for ${terminal} did not become available.`);
  await cx.sleep(140);
  check();
  const current = panes().find((p) => p.terminal === terminal);
  if (!current?.program?.shell || current.program.agent || current.status) throw new Error(`The shell for ${terminal} is no longer available.`);
  // hc send already submits Enter. Appending a newline submits twice.
  const r = await hc(["send", terminal, command.replace(/\r?\n$/, "")]);
  if (r.code !== 0) throw new Error(r.stderr?.trim() || `Could not send to ${terminal}`);
  check();
}

async function folderExists(folder, on) {
  const r = await shellProbe(`test -d ${shq(folder)}`,
    `if (Test-Path -LiteralPath ${psq(folder)} -PathType Container) { exit 0 } else { exit 1 }`, on);
  return r.code === 0;
}

export default class SpaceBuilder extends View {
  init(_props, cx) {
    this.loading = true;
    this.busy = false;
    this.status = LOADING_STATUS;
    this.error = null;
    this.globalSpaces = [];
    this.globalMeta = [];
    this.operation = null;
    this.created = null;
    this.doneName = null;
    this.closed = false;
    this.browsing = false;
    this.browseError = null;
    this.pending = null;
    this.pendingChoice = "reload";
    this.handle = cx.focus_handle();
    this.selected = null;
    this.top = 0;
    this.query = "";
    this.inputFocused = false;
    this.configPath = storedConfigPath();
    this.configState = "loading";
    this.configError = null;
    this.configEmpty = false;
    this.input = InputState.new({ placeholder: "Search name or machine…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.selectFirst();
      this.top = 0;
      this.ensureTop();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.chooseVisible(cx));
    this.input.on("focus", () => { this.inputFocused = true; });
    this.input.on("blur", () => { this.inputFocused = false; });
    // Opened from a key, this is an overlay; a check or a bare copy does nothing.
    if (!props()?.overlay) {
      this.loading = false;
      this.status = "Open Space builder from its key.";
      return;
    }
    this.handle.focus();
    this.listenForCommands(cx);
    this.prune();
    cx.spawn(async (cx) => {
      try {
        await this.loadConfig(cx);
      } catch (e) {
        this.loading = false;
        this.error = String(e?.message ?? e);
        this.handle.focus();
        cx.notify();
      }
    });
  }

  async loadConfig(cx) {
    this.loading = true;
    this.status = LOADING_STATUS;
    this.configState = "loading";
    this.configError = null;
    this.configEmpty = false;
    this.globalSpaces = [];
    this.globalMeta = [];
    this.selected = null;
    this.top = 0;
    cx.notify();
    try {
      const text = await readTextFile(this.configPath);
      if (this.closed) return;
      if (text === null) {
        this.configState = "missing";
      } else {
        this.globalSpaces = parseConfigs(text);
        await this.resolveGlobals();
        if (this.closed) return;
        this.configState = "found";
        this.configEmpty = this.globalSpaces.length === 0;
      }
    } catch (e) {
      this.configState = "invalid";
      this.configError = String(e?.message ?? e);
    }
    if (this.closed) return;
    this.loading = false;
    this.status = "";
    this.pickFirst(cx);
    cx.notify();
  }

  async resolveGlobals() {
    this.globalMeta = this.globalSpaces.map((data) => {
      try { validate(data); return { target: targetOf(data), key: spaceKey(data) }; }
      catch (e) { return { error: String(e?.message ?? e) }; }
    });
    const counts = new Map();
    this.globalSpaces.forEach((data, index) => {
      if (!this.globalMeta[index].error) counts.set(spaceKey(data), (counts.get(spaceKey(data)) ?? 0) + 1);
    });
    this.globalSpaces.forEach((data, index) => {
      if (!this.globalMeta[index].error && counts.get(spaceKey(data)) > 1) this.globalMeta[index] = {
        error: `Duplicate configuration "${nameOf(data)}" on ${targetOf(data) || "local"}. Names must be unique per machine.`,
      };
    });
  }

  liveMatches(data) {
    return spaces().filter((space) => space.name === nameOf(data)
      && (space.machine ?? null) === targetOf(data));
  }

  openInfo(index) {
    const data = this.globalSpaces[index];
    const matches = nameOf(data) ? this.liveMatches(data) : [];
    return { target: targetOf(data), key: spaceKey(data), open: matches.length > 0 };
  }

  entries() {
    const list = this.globalSpaces.map((_, index) => ({ kind: "global", index, ...this.openInfo(index) }));
    return list.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || a.index - b.index);
  }

  visibleEntries() {
    const parts = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = this.entries();
    if (!parts.length) return list;
    return list.filter((entry) => {
      const data = this.globalSpaces[entry.index];
      const name = typeof data.name === "string" ? data.name : "";
      const hay = `${name} ${entry.target ?? ""}`.toLowerCase();
      return parts.every((part) => hay.includes(part));
    });
  }

  entryEnabled(entry) {
    const data = this.globalSpaces[entry.index];
    const meta = this.globalMeta?.[entry.index];
    return Boolean(data) && !meta?.error && machineInfo(meta?.target ?? targetOf(data)).ok;
  }

  selectFirst() {
    this.selected = this.visibleEntries().find((entry) => this.entryEnabled(entry))?.index ?? null;
  }

  pickFirst(cx) {
    this.selectFirst();
    this.top = 0;
    this.ensureTop();
    this.handle.focus();
    if (this.configState === "found" && this.globalSpaces.length > 0) {
      this.input.focus();
      cx?.timer?.after?.(50, () => { if (!this.closed && !this.pending && !this.busy) this.input.focus(); });
    }
  }

  listView() {
    const list = this.visibleEntries();
    const previous = this.selected;
    if (!list.some((entry) => entry.index === this.selected && this.entryEnabled(entry))) {
      this.selected = list.find((entry) => this.entryEnabled(entry))?.index ?? null;
    }
    const selectedPosition = list.findIndex((entry) => entry.index === this.selected);
    const order = list.map((entry) => entry.index).join(",");
    const reordered = this.listOrder !== order || previous !== this.selected;
    this.listOrder = order;
    const n = list.length;
    const maxRows = Math.max(1, Math.floor((LIST_MAX_H + ROW_GAP) / (ENTRY_H + ROW_GAP)));
    const count = Math.min(n, maxRows);
    const height = count > 0 ? count * ENTRY_H + (count - 1) * ROW_GAP : 0;
    const maxTop = Math.max(0, n - count);
    let top = Math.max(0, Math.min(this.top ?? 0, maxTop));
    if (reordered && selectedPosition >= 0) {
      if (selectedPosition < top) top = selectedPosition;
      else if (selectedPosition >= top + count) top = selectedPosition - count + 1;
      this.top = top;
    }
    const shown = list.slice(top, top + count);
    const total = n > 0 ? n * ENTRY_H + (n - 1) * ROW_GAP : 0;
    return { entries: list, top, shown, height, maxTop, total, offset: top * (ENTRY_H + ROW_GAP), count, selectedPosition };
  }

  ensureTop() {
    const view = this.listView();
    if (!view.entries.length) { this.top = 0; return; }
    this.top = Math.max(0, Math.min(this.top ?? 0, view.maxTop));
    if (view.selectedPosition >= 0 && view.selectedPosition < this.top) this.top = view.selectedPosition;
    else if (view.selectedPosition >= this.top + view.count) this.top = view.selectedPosition - view.count + 1;
    this.top = Math.max(0, Math.min(this.top, view.maxTop));
  }

  listenForCommands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        if (command === "escape" && this.escape(cx)) return;
      }
    });
  }

  escape(cx) {
    if (this.closed) return true;
    if (this.pending) {
      this.cancelReload(cx);
      return false;
    }
    // Stop work immediately; close() performs the bounded cleanup when the
    // host removes the overlay. Both key routes share this cancellation path.
    this.closed = true;
    if (this.operation && !this.operation.committed) this.operation.cancelled = true;
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    return true;
  }

  key(e, cx) {
    if (e.key === "escape") {
      cx.stop_propagation();
      this.escape(cx);
      return;
    }
    if (this.pending) {
      if (e.key === "left" || e.key === "right") {
        this.pendingChoice = this.pendingChoice === "reload" ? "cancel" : "reload";
        cx.notify();
      } else if (e.key === "enter") {
        if (this.pendingChoice === "cancel") this.cancelReload(cx);
        else this.reload(cx);
      }
      cx.stop_propagation();
      return;
    }
    if (this.error) {
      if (e.key === "enter") closeOverlay(props().overlay);
      cx.stop_propagation();
      return;
    }
    if (this.loading || this.busy || this.doneName || this.browsing) return;
    const canSearch = this.configState === "found" && this.globalSpaces.length > 0;
    const list = canSearch ? this.visibleEntries() : [];
    if (!list.length) {
      if (e.key === "enter" && !canSearch) { this.browse(cx); cx.stop_propagation(); }
      return;
    }
    if (e.key === "enter" && !this.inputFocused) {
      this.chooseVisible(cx);
      cx.stop_propagation();
    } else if (e.key === "down" || e.key === "up") {
      const step = e.key === "down" ? 1 : -1;
      let at = list.findIndex((entry) => entry.index === this.selected);
      if (at < 0) at = step > 0 ? -1 : 0;
      for (let n = 0; n < list.length; n++) {
        at = (at + step + list.length) % list.length;
        if (this.entryEnabled(list[at])) {
          this.selected = list[at].index;
          this.ensureTop();
          cx.notify();
          break;
        }
      }
      cx.stop_propagation();
    } else if (e.key === "/" && !this.inputFocused) {
      this.input.focus();
      cx.stop_propagation();
    }
  }

  browse(cx) {
    if (this.browsing || this.busy || this.pending || this.closed) return;
    this.browsing = true;
    this.browseError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "Choose the folder containing spaces.json" }).catch(() => null);
        if (!folder || this.closed) return;
        const path = joinPath(folder, CONFIG_NAME);
        setShared(CONFIG_KEY, path);
        this.configPath = path;
        this.query = "";
        this.input.set_value("");
        await this.loadConfig(cx);
      } catch (e) {
        this.browseError = String(e?.message ?? e);
      } finally {
        this.browsing = false;
        if (!this.closed) {
          if (this.configState === "found" && this.globalSpaces.length > 0) this.input.focus();
          else this.handle.focus();
          cx.notify();
        }
      }
    });
  }

  chooseVisible(cx) {
    const entry = this.listView().entries.find((item) => item.index === this.selected);
    if (entry && this.entryEnabled(entry)) this.choose(entry.index, cx);
  }

  choose(index, cx) {
    const data = this.globalSpaces?.[index];
    if (!data || !this.entryEnabled({ index }) || this.loading || this.busy || this.pending || this.closed || this.browsing) return;
    try {
      validate(data);
      validateMachine(targetOf(data));
      if (this.askReload(data, cx)) return;
      this.startBuild(data, cx);
    } catch (e) {
      notify({ title: "Space builder", body: String(e?.message ?? e), level: "error" });
    }
  }

  assertAvailable(data, expected = null) {
    validateMachine(targetOf(data));
    const matches = this.liveMatches(data);
    if (matches.length > 1) throw new Error(`Multiple spaces named "${nameOf(data)}" exist on ${targetOf(data) || "local"}. Rename or close one before reloading.`);
    if (expected !== null) {
      if (matches.length !== 1 || matches[0].id !== expected) throw new Error("The selected space changed. Reopen the configuration before reloading.");
    } else if (matches.length) {
      throw new Error(`"${nameOf(data)}" is already open. Select it again to confirm reload.`);
    }
    return matches[0] ?? null;
  }

  assertReservation(data, token = null) {
    const prior = (shared(STATE) ?? {})[spaceKey(data)];
    if (prior?.phase === "building" && Date.now() - prior.at < RESERVATION_TTL && prior.token !== token) {
      throw new Error(`${nameOf(data)} is already being built.`);
    }
  }

  askReload(data, cx) {
    this.assertReservation(data);
    const matches = this.liveMatches(data);
    if (matches.length > 1) this.assertAvailable(data);
    if (!matches.length) return false;
    this.pending = { data: JSON.parse(JSON.stringify(data)), name: nameOf(data), space: matches[0].id };
    this.pendingChoice = "reload";
    this.handle.focus();
    cx.notify();
    return true;
  }

  cancelReload(cx) {
    this.pending = null;
    if (this.configState === "found" && this.globalSpaces.length > 0) this.input.focus();
    else this.handle.focus();
    cx.notify();
  }

  reload(cx) {
    const p = this.pending;
    if (!p || this.busy || this.closed) return;
    this.pending = null;
    this.busy = true;
    this.error = null;
    this.doneName = null;
    this.created = null;
    const op = this.beginOperation(spaceKey(p.data));
    this.status = LOADING_STATUS;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const plan = await this.preflight(p.data);
        this.checkOperation(op);
        this.assertAvailable(plan.data, p.space);
        this.reserve(op, plan, cx);
        // Recheck the live name, machine, unique match and confirmed id immediately
        // before the destructive command. Saved markers never choose its target.
        this.assertAvailable(plan.data, p.space);
        await cli("space.close", { id: p.space, confirmed: true });
        this.checkOperation(op);
        for (let i = 0; i < 100 && spaces().some((space) => space.id === p.space); i++) await cx.sleep(50);
        if (spaces().some((space) => space.id === p.space)) throw new Error("The space did not close.");
        this.checkOperation(op);
        const result = await this.build(p.data, cx, plan);
        op.committed = true;
        this.release(op);
        this.finish(result, cx);
      } catch (e) { await this.fail(e, p.name, "reload", cx); }
    });
  }

  finish(result, cx) {
    if (!result) return;
    this.loading = false;
    this.busy = false;
    this.created = null;
    this.doneName = null;
    this.status = "";
    const overlay = props().overlay;
    if (overlay) closeOverlay(overlay);
    else cx.notify();
  }

  async fail(e, name, action = "build", cx) {
    const op = this.operation;
    let cleanupError = null;
    try { await this.cleanup(op); } catch (err) { cleanupError = err; }
    this.busy = false;
    if (this.closed || e instanceof Cancelled) return;
    const message = String(e?.message ?? e);
    notify({ title: "Space builder", body: `Could not ${action} ${name || "space"}: ${message}`, level: "error" });
    if (cleanupError) {
      this.error = `${message} Cleanup failed: ${cleanupError.message}. The partial space is still tracked; close it or retry reload.`;
      if (op?.key && (shared(STATE) ?? {})[op.key]?.token === op.token) {
        setShared(STATE, { ...shared(STATE), [op.key]: { ...shared(STATE)[op.key], phase: "partial" } });
      }
      cx?.notify();
      return;
    }
    if (props().overlay) closeOverlay(props().overlay);
  }

  startBuild(data, cx) {
    if (this.closed || this.busy) return;
    this.busy = true;
    this.error = null;
    this.doneName = null;
    this.created = null;
    const op = this.beginOperation(spaceKey(data));
    const name = nameOf(data);
    this.status = LOADING_STATUS;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.build(data, cx);
        op.committed = true;
        this.release(op);
        this.finish(result, cx);
      } catch (e) { await this.fail(e, name, "build", cx); }
    });
  }

  closePartial(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.cleanup();
        this.busy = false;
        if (props().overlay) closeOverlay(props().overlay);
      } catch (e) {
        this.busy = false;
        this.error = `Could not clean up the partial build: ${e.message}`;
        cx.notify();
      }
    });
  }

  async close() {
    this.closed = true;
    if (this.operation && !this.operation.committed) {
      this.operation.cancelled = true;
      // Start cleanup here, rather than awaiting work from the cancelled task.
      try { await this.cleanup(); }
      catch (e) {
        console.log(`Space builder cleanup: ${e.message}`);
        const op = this.operation;
        if ((shared(STATE) ?? {})[op.key]?.token === op.token) {
          setShared(STATE, { ...shared(STATE), [op.key]: { ...shared(STATE)[op.key], phase: "partial" } });
        }
      }
    }
  }

  checkOperation(op = this.operation) {
    if (this.closed || op?.cancelled) throw new Cancelled();
  }

  beginOperation(key) {
    if (this.closed) throw new Cancelled();
    const op = { key, token: `${Date.now()}-${Math.random()}`, created: null, firstTab: null,
      inFlight: 0, committed: false, cancelled: false };
    this.operation = op;
    return op;
  }

  saveOperation(op) {
    const plan = op.plan;
    setShared(STATE, { ...(shared(STATE) ?? {}), [op.key]: {
      space: op.created || null, tab: op.firstTab || null,
      name: plan.name, machine: plan.target, token: op.token, phase: "building", at: Date.now(),
    } });
  }

  async create(op, command, args, record) {
    this.checkOperation(op);
    op.inFlight++;
    try {
      const created = await cli(command, args);
      // Record returned ids before touching cx or checking cancellation. A close
      // may have happened while the subprocess was making the new terminal.
      record(created);
      this.checkOperation(op);
      this.saveOperation(op);
      return created;
    } finally { op.inFlight--; }
  }

  reserve(op, plan, cx) {
    this.assertReservation(plan.data, op.token);
    op.plan = plan;
    op.key = spaceKey(plan.data);
    this.saveOperation(op);
    if (!op.heartbeat) {
      // Directory probes and shell/command waits can outlast the lease even
      // without structural creation. Refresh only this operation's record.
      op.heartbeat = cx.timer.every(RESERVATION_REFRESH, () => {
        const all = shared(STATE) ?? {};
        const marker = all[op.key];
        if (this.closed || op.cancelled || op.committed || marker?.token !== op.token || marker.phase !== "building") {
          this.stopHeartbeat(op);
          return;
        }
        setShared(STATE, { ...all, [op.key]: { ...marker, at: Date.now() } });
      });
    }
  }

  stopHeartbeat(op) {
    op?.heartbeat?.cancel();
    if (op) op.heartbeat = null;
  }

  release(op) {
    this.stopHeartbeat(op);
    if ((shared(STATE) ?? {})[op.key]?.token === op.token) this.forget(op.key);
  }

  async build(data, cx, prepared = null) {
    const op = this.operation ?? this.beginOperation(spaceKey(data));
    this.checkOperation(op);
    const plan = prepared ?? await this.preflight(data);
    this.checkOperation(op);
    this.assertAvailable(plan.data);
    this.reserve(op, plan, cx);
    const { target, name, tabs } = plan;
    const first = tabs[0];
    let spaceId, firstTabId, firstRootPane, firstRootTerminal;

    this.checkOperation(op);
    const created = await this.create(op, "space.new",
      { name, folder: first.root.dir ?? undefined, tab: first.name, machine: target ?? "" }, (made) => {
        op.created = this.created = made.space;
        op.firstTab = made.tab;
      });
    spaceId = created.space;
    firstTabId = created.tab;
    firstRootTerminal = created.terminal;
    this.checkOperation(op);
    firstRootPane = await paneFor(firstRootTerminal, cx);

    this.checkOperation(op);
    await this.prepareTab(first, firstRootTerminal, cx, op);
    await this.startPane(firstRootTerminal, first.root, cx, op);
    await this.buildSplits(first, firstRootPane, cx, op);

    for (const tab of tabs.slice(1)) {
      this.checkOperation(op);
      const made = await this.create(op, "tab.new",
        { name: tab.name, space: spaceId, folder: tab.root.dir ?? undefined }, () => {});
      this.checkOperation(op);
      const rootPane = await paneFor(made.terminal, cx);
      await this.prepareTab(tab, made.terminal, cx, op);
      await this.startPane(made.terminal, tab.root, cx, op);
      await this.buildSplits(tab, rootPane, cx, op);
    }
    this.checkOperation(op);
    await cli("tab.select", { id: firstTabId });
    this.checkOperation(op);
    await cli("pane.focus", { pane: firstRootPane });
    this.checkOperation(op);
    return { name, space: spaceId, tab: firstTabId, machine: target ?? null };
  }

  async shellFor(terminal, cx, op) {
    for (let i = 0; i < 100; i++) {
      this.checkOperation(op);
      const live = panes().find((pane) => pane.terminal === terminal);
      if (live?.program?.shell && !live.program.agent && !live.status && live.cwd) return live;
      await cx.sleep(50);
    }
    throw new Error(`The shell for ${terminal} did not become available.`);
  }

  async prepareTab(tab, terminal, cx, op) {
    const live = await this.shellFor(terminal, cx, op);
    const rootDir = tab.root.dir ?? norm(live.cwd);
    tab.root.effectiveDir = rootDir;
    for (const pane of tab.panes) {
      if (pane === tab.root) continue;
      const dir = await expand(pane.working_dir, rootDir, op.plan.target);
      this.checkOperation(op);
      // Only the native shell can establish an unspecified root's cwd. Check
      // dependent paths here before submitting any commands for this tab.
      if (dir !== pane.dir && !(await folderExists(dir, op.plan.target))) throw new Error(`Folder does not exist: ${dir}`);
      pane.dir = dir;
    }
  }

  async startPane(terminal, pane, cx, op) {
    const live = await this.shellFor(terminal, cx, op);
    const shell = /^(pwsh|powershell)$/i.test(live.program.key)
      ? live.program.key : live.program.name;
    // The app's cwd snapshot can lag a parent's cd. Reassert the planned
    // directory rather than trusting that inherited snapshot for a new split.
    await send(terminal, withCd(pane.command, null, pane.dir, shell), cx, () => this.checkOperation(op));
  }

  async buildSplits(tab, rootPane, cx, op) {
    const ids = new Map([[tab.root.id, rootPane]]);
    for (const pane of tab.panes) {
      if (pane === tab.root) continue;
      this.checkOperation(op);
      const from = ids.get(pane.split_from);
      if (!from) throw new Error(`Pane "${pane.id}" has no created parent.`);
      // Explicitly target the model pane. Focus is never an input to creation.
      const created = await this.create(op, "pane.split", { pane: from, direction: pane.split }, () => {});
      this.checkOperation(op);
      const childPane = created.pane || await paneFor(created.terminal, cx);
      ids.set(pane.id, childPane);
      await this.startPane(created.terminal, pane, cx, op);
    }
  }

  async cleanup(op = this.operation) {
    this.stopHeartbeat(op);
    if (!op || op.committed) return;
    if (op.created) {
      await cli("space.close", { id: op.created, confirmed: true });
      if (this.created === op.created) this.created = null;
      op.created = null;
    }
    if (!op.inFlight && (shared(STATE) ?? {})[op.key]?.token === op.token) this.forget(op.key);
  }

  // Resolvable directories are checked before a destructive reload. Roots
  // without working_dir are left to Herdr; capture their actual cwd on creation.
  async preflight(data) {
    validate(data);
    data = JSON.parse(JSON.stringify(data));
    const target = targetOf(data);
    validateMachine(target);
    const context = focused();
    const active = spaces().find((space) => space.id === context?.space) ?? spaces().find((space) => space.active);
    let defaultDir;
    const nativeDefault = async () => {
      if (!defaultDir) defaultDir = (active?.machine ?? null) === target && context?.cwd
        ? norm(context.cwd) : await homeOn(target);
      return defaultDir;
    };
    const checked = new Set();
    const checkFolder = async (folder) => {
      if (!folder || checked.has(pathKey(folder))) return;
      if (!(await folderExists(folder, target))) throw new Error(`Folder does not exist: ${folder}`);
      checked.add(pathKey(folder));
    };
    const tabs = [];
    for (const tab of data.tabs) {
      const root = tab.panes.find((pane) => !pane.split_from);
      const rootBase = hasDirectory(root)
        ? await expand(root.working_dir, absolute(root.working_dir) || root.working_dir.startsWith("~") ? null : await nativeDefault(), target)
        : null;
      await checkFolder(rootBase);
      const resolved = [];
      for (const pane of tab.panes) {
        let dir = rootBase;
        if (pane !== root) {
          const raw = pane.working_dir;
          const independent = hasDirectory(pane) && (absolute(raw) || raw.startsWith("~"));
          // With no configured root directory, Herdr and shell startup decide
          // the actual cwd. Do not reject a guessed path from another tab or
          // from the popup's previous focus; prepareTab resolves it before input.
          dir = independent || rootBase ? await expand(raw, rootBase, target) : null;
        }
        await checkFolder(dir);
        resolved.push({ ...pane, dir });
      }
      tabs.push({ name: tab.name, panes: resolved, root: resolved.find((pane) => !pane.split_from) });
    }
    validateMachine(target);
    return { data, target, tabs, name: nameOf(data) };
  }

  prune() {
    const all = shared(STATE) ?? {};
    const next = {};
    for (const [key, marker] of Object.entries(all)) {
      if (!marker || typeof marker !== "object") continue;
      const recent = marker.phase === "building" && Date.now() - marker.at < RESERVATION_TTL;
      if (recent || !machineReady(marker.machine ?? null) || spaces().some((space) => space.id === marker.space)) next[key] = marker;
    }
    if (Object.keys(next).length !== Object.keys(all).length) setShared(STATE, next);
  }

  forget(key) {
    const all = shared(STATE) ?? {};
    if (!(key in all)) return;
    const next = { ...all };
    delete next[key];
    setShared(STATE, next);
  }

  button(t, id, label, primary, action) {
    return h_flex().id(id).h(30).flex_none().px(12).items_center().rounded(7)
      .border_1().border_color(primary ? t.accent : t.input)
      .bg(primary ? t.accent : t.raised)
      .text_color(primary ? t.accent_foreground : t.foreground)
      .text_size(12).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88))
      .on_click(action).child(label);
  }

  keycap(t, label, minW = 22) {
    return h_flex().flex_none().justify_center().items_center().h(22).min_w(minW).px(6)
      .rounded(5).bg(t.raised).border_1().border_color(t.border)
      .child(div().text_size(10.5).font_medium().text_color(t.muted).child(label));
  }

  closeButton(t) {
    return h_flex().id("wb-close").w(26).h(26).flex_none().justify_center().items_center()
      .rounded(6).bg(t.raised).border_1().border_color(t.border)
      .cursor_pointer().hover((s) => s.opacity(0.85))
      .on_click(() => closeOverlay(props().overlay))
      .child(svg(X_ICON).size(13).text_color(t.muted));
  }

  toggleKey() {
    return keys().find((binding) =>
      binding.section === "global" && binding.action === "mod.open:space-builder")?.keys ?? null;
  }

  titleRow(t) {
    const list = this.entries();
    const total = list.length;
    const open = list.filter((entry) => entry.open).length;
    const available = list.filter((entry) => !entry.open && this.entryEnabled(entry)).length;
    const showCount = this.configState === "found" && total > 0 && !this.loading;
    const toggle = this.toggleKey();
    return h_flex().w_full().flex_none().items_center().justify_between()
      .child(div().text_size(20).font_semibold().text_color(t.foreground).child("Open a space"))
      .child(h_flex().flex_none().items_center().gap(12)
        .when(showCount, (el) => el.child(h_flex().items_center().gap(6)
          .child(div().w(6).h(6).rounded(3).bg(t.done))
          .child(div().text_size(11).text_color(t.dim).child(`${open} open · ${available} available`))))
        .when(Boolean(toggle), (el) => el.child(this.keycap(t, toggle)))
        .child(this.closeButton(t)));
  }

  searchBox(t) {
    return h_flex().w_full().h(44).flex_none().px(12).gap(10).items_center().rounded(10)
      .border_1().border_color(t.accent).bg(t.background)
      .child(svg(SEARCH_ICON).size(16).flex_none().text_color(t.dim))
      .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
      .child(this.keycap(t, "/", 22));
  }

  configButton(t) {
    const primary = this.configState !== "found" || this.configEmpty;
    return h_flex().id("wb-config").flex_none().h(28).px(10).gap(6).items_center().rounded(6)
      .border_1().border_color(primary ? t.accent : t.input)
      .bg(primary ? t.accent : t.raised)
      .cursor_pointer().hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => this.browse(cx))
      .tooltip(this.configPath)
      .child(svg(SETTINGS_ICON).size(12).flex_none().text_color(primary ? t.accent_foreground : t.muted))
      .child(div().text_size(10.5).font_medium()
        .text_color(primary ? t.accent_foreground : t.muted)
        .child(this.browsing ? "Choosing…" : "Configuration…"));
  }

  machineChip(t, target) {
    return h_flex().flex_none().h(21).px(7).gap(5).items_center().rounded(5)
      .bg(t.raised).border_1().border_color(t.border)
      .child(svg(SERVER_ICON).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(10.5).font_medium().text_color(t.muted).child(target));
  }

  dot(t, open) {
    // Even diameters keep both circles on the same pixel center.
    return open
      ? h_flex().flex_none().w(16).h(16).rounded(8).bg(tint(t.done, 0.18)).items_center().justify_center()
        .child(div().w(8).h(8).rounded(4).bg(t.done))
      : h_flex().flex_none().w(16).h(16).items_center().justify_center()
        .child(div().w(8).h(8).rounded(4).border_1().border_color(t.dim));
  }

  globalRow(t, entry, cx, selected = false) {
    const data = this.globalSpaces[entry.index];
    const meta = this.globalMeta?.[entry.index];
    const target = meta?.error ? null : (meta?.target ?? targetOf(data));
    const info = meta?.error ? { ok: false, label: meta.error } : machineInfo(target);
    const disabled = !info.ok;
    const rawName = typeof data.name === "string" ? data.name : "";
    const name = rawName || "Untitled space";
    const unnamed = !rawName;
    const open = entry.open;
    return h_flex().id(`wb-${entry.index}`).w_full().h(ENTRY_H).flex_none().px(12).gap(10).items_center().rounded(9)
      .border_1().border_color(selected ? t.accent : open ? tint(t.done, 0.28) : t.border)
      .bg(selected ? t.selected : open ? tint(t.done, 0.07) : t.raised)
      .when(disabled, (el) => el.opacity(0.65))
      .cursor_pointer()
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => {
        if (disabled) { notify({ title: "Space builder", body: info.label }); return; }
        this.choose(entry.index, cx);
      })
      .child(this.dot(t, open))
      .child(div().flex_1().min_w(0).truncate().tooltip(meta?.error || name)
        .text_size(unnamed ? 11.5 : 13.5)
        .font_medium()
        .when(open, (el) => el.font_semibold())
        .text_color(open ? t.foreground : t.muted)
        .child(name))
      .when(Boolean(target), (el) => el.child(this.machineChip(t, target)));
  }

  list(t, view, cx) {
    const current = view.entries.find((entry) => entry.index === this.selected);
    const bar = view.maxTop > 0 ? (() => {
      const trackH = view.height;
      const thumbH = Math.max(20, (view.height / view.total) * trackH);
      const maxOffset = Math.max(1, view.total - view.height);
      const thumbTop = Math.max(0, Math.min(
        (view.offset / maxOffset) * (trackH - thumbH),
        trackH - thumbH,
      ));
      return [
        div().absolute().right(0).top(0).w(4).h(trackH).rounded(2).bg(t.border).opacity(0.5),
        div().absolute().right(0).top(thumbTop).w(4).h(thumbH).rounded(2).bg(t.muted),
      ];
    })() : [];
    return v_flex().id("wb-list").relative().w_full().flex_none().h(view.height + 10).px(10).pb(10)
      .overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        const now = this.listView();
        if (now.maxTop <= 0) return;
        const step = e.delta.y > 0 ? 1 : -1;
        this.top = Math.max(0, Math.min(now.top + step, now.maxTop));
        const visible = now.entries.slice(this.top, this.top + now.count);
        if (!visible.some((entry) => entry.index === this.selected)) {
          const candidates = step > 0 ? visible : [...visible].reverse();
          this.selected = candidates.find((entry) => this.entryEnabled(entry))?.index ?? this.selected;
        }
        cx.notify();
      })
      .child(v_flex().w_full().gap(ROW_GAP)
        .children(view.shown.map((entry) => this.globalRow(t, entry, cx, current?.index === entry.index))))
      .children(bar);
  }

  footer(t) {
    const found = this.configState === "found" && this.globalSpaces.length > 0;
    const total = this.globalSpaces.length;
    return v_flex().w_full().flex_none()
      .child(div().w_full().h(1).bg(t.border))
      .child(h_flex().w_full().items_center().justify_between().px(18).py(12)
        .child(found
          ? h_flex().items_center().gap(13)
            .child(h_flex().items_center().gap(5).child(this.keycap(t, "↑↓", 28)).child(div().text_size(11).text_color(t.dim).child("move")))
            .child(h_flex().items_center().gap(5).child(this.keycap(t, "↵", 22)).child(div().text_size(11).text_color(t.dim).child("open / reload")))
            .child(h_flex().items_center().gap(5).child(this.keycap(t, "/", 22)).child(div().text_size(11).text_color(t.dim).child("search")))
          : h_flex().items_center().gap(10)
            .child(div().text_size(11).text_color(t.dim).child("esc close"))
            .child(div().w(1).h(12).bg(t.border))
            .child(div().text_size(11).text_color(t.dim).child(`${total} configurations`)))
        .child(h_flex().items_center().gap(10)
          .child(this.configButton(t))
          .when(found, (el) => el.child(div().text_size(11).text_color(t.dim).child("esc close")))));
  }

  emptyState(t, cx) {
    const query = this.query.trim();
    const noMatches = this.configState === "found" && this.globalSpaces.length > 0 && query;
    const missing = this.configState === "missing";
    const invalid = this.configState === "invalid";
    const empty = this.configState === "found" && this.globalSpaces.length === 0;
    const pathBlock = () => h_flex().max_w(470).px(10).py(6).rounded(6).bg(t.raised)
      .border_1().border_color(t.border)
      .child(div().text_size(10.5).text_color(t.muted).child(this.configPath));
    const clear = () => h_flex().id("wb-clear").h(30).px(12).rounded(7).border_1().border_color(t.input)
      .bg(t.raised).cursor_pointer().hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => {
        this.input.set_value("");
        this.query = "";
        this.selectFirst();
        this.top = 0;
        this.input.focus();
        cx.notify();
      })
      .child(div().text_size(12).font_medium().text_color(t.foreground).child("Clear search"));
    return v_flex().id("wb-empty").w_full().items_center().justify_center().py(40).px(46).gap(8)
      .child(div().w(38).h(38).rounded(19).bg(t.raised).items_center().justify_center()
        .child(svg(noMatches ? SEARCH_ICON : FILE_ICON).size(18).text_color(t.dim)))
      .when(noMatches, (el) => el
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("No configurations match"))
        .child(div().text_size(11.5).text_color(t.dim).child(`“${query}”`))
        .child(div().text_size(11.5).text_color(t.dim).child("Try a different search."))
        .child(clear()))
      .when(missing, (el) => el
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("No configurations loaded"))
        .child(div().text_size(11.5).text_color(t.dim).child("The config file doesn’t exist."))
        .child(div().text_size(11.5).text_color(t.dim).child("Create it at path"))
        .child(pathBlock())
        .child(div().text_size(11.5).text_color(t.dim).child("or use Configuration to choose another file.")))
      .when(invalid, (el) => el
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Could not read the config file"))
        .child(div().text_size(11.5).text_color(t.blocked).child(this.configError || "The file could not be read."))
        .child(div().text_size(11.5).text_color(t.dim).child("Fix it, or use Configuration to choose another file."))
        .child(pathBlock()))
      .when(empty, (el) => el
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("No configurations found"))
        .child(div().text_size(11.5).text_color(t.dim).child("Add space configurations to"))
        .child(pathBlock())
        .child(div().text_size(11.5).text_color(t.dim).child("or use Configuration to choose another file.")));
  }

  header(t) {
    const canSearch = this.configState === "found" && this.globalSpaces.length > 0;
    return v_flex().w_full().flex_none().p(22).pb(14).gap(14)
      .child(this.titleRow(t))
      .when(canSearch, (el) => el.child(this.searchBox(t)))
      .when(Boolean(this.browseError), (el) => el
        .child(div().text_size(11).text_color(t.blocked).child(this.browseError)));
  }

  render(cx) {
    const t = theme();
    if (this.pending) {
      return v_flex().id("space-builder-reload").w_full().p(22).gap(12)
        .track_focus(this.handle)
        .on_key_down((e, cx) => this.key(e, cx))
        .bg(t.popover).text_color(t.foreground)
        .child(div().text_size(20).font_semibold().child("Open a space"))
        .child(div().text_size(13).text_color(t.foreground).child(`${this.pending.name} is already open.`))
        .child(div().text_size(11.5).text_color(t.muted).child("Reloading closes the existing space, then recreates it from the configuration."))
        .child(h_flex().gap(8).justify_end()
          .child(this.button(t, "wb-cancel-reload", "Cancel", this.pendingChoice === "cancel", (_e, cx) => this.cancelReload(cx)))
          .child(this.button(t, "wb-reload", "Reload space", this.pendingChoice !== "cancel", (_e, cx) => this.reload(cx))));
    }

    if (this.error) {
      return v_flex().id("space-builder").w_full().p(22).gap(12)
        .track_focus(this.handle)
        .on_key_down((e, cx) => this.key(e, cx))
        .bg(t.popover).text_color(t.foreground)
        .child(div().text_size(20).font_semibold().child("Open a space"))
        .child(div().text_size(12).text_color(t.blocked).child(this.error))
        .child(h_flex().gap(8).justify_end()
          .when(Boolean(this.created), (el) => el.child(this.button(t, "wb-remove", "Close partial space", false, (_e, cx) => this.closePartial(cx))))
          .child(this.closeButton(t)));
    }

    if (this.loading || this.busy || this.doneName) {
      return v_flex().id("space-builder").w_full().p(22).gap(12)
        .track_focus(this.handle)
        .on_key_down((e, cx) => this.key(e, cx))
        .bg(t.popover).text_color(t.foreground)
        .child(div().text_size(20).font_semibold().child("Open a space"))
        .child(div().text_size(12).text_color(t.muted).child(this.status || LOADING_STATUS))
        .child(h_flex().justify_end().child(this.closeButton(t)));
    }

    const view = this.listView();
    const canSearch = this.configState === "found" && this.globalSpaces.length > 0;
    const showList = canSearch && view.entries.length > 0;
    return v_flex().id("space-builder").w_full().min_h(0)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .bg(t.popover).text_color(t.foreground)
      .child(this.header(t))
      .when(showList, (el) => el.child(this.list(t, view, cx)))
      .when(!showList, (el) => el.child(this.emptyState(t, cx)))
      .child(this.footer(t));
  }
}
