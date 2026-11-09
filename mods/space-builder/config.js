// Configuration and path rules, independent of the view and app focus.
export const isWindowsPath = (path) => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);

export function norm(path) {
  const windows = isWindowsPath(path);
  const text = windows ? path.replace(/\\/g, "/") : String(path ?? "");
  const prefix = text.startsWith("//") && windows ? "//"
    : /^[A-Za-z]:\//.test(text) ? text.slice(0, 3) : text.startsWith("/") ? "/" : "";
  const parts = [];
  const floor = prefix === "//" ? 2 : 0;
  for (const part of text.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > floor && parts[parts.length - 1] !== "..") parts.pop();
    else if (part === ".." && !prefix) parts.push(part);
    else if (part !== "..") parts.push(part);
  }
  return prefix + parts.join("/") || ".";
}

export const pathKey = (path) => isWindowsPath(path) ? norm(path).toLowerCase() : norm(path);
export const absolute = (path) => path.startsWith("/") || isWindowsPath(path);
export const base = (path) => String(path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "space";
export const targetOf = (data) => typeof data?.machine === "string" ? data.machine.trim() || null : null;

// Space identity is its exact name within one machine. Directories are pane state.
export const nameOf = (data) => typeof data?.name === "string" ? data.name.trim() : "";
export const spaceKey = (data) => JSON.stringify(["space", targetOf(data), nameOf(data)]);
export const hasDirectory = (pane) => typeof pane?.working_dir === "string" && pane.working_dir !== "";

export function parseConfigs(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data
    : data && Array.isArray(data.spaces) ? data.spaces
    : data && Array.isArray(data.tabs) ? [data] : null;
  if (!list || list.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error('Expected a space object, an array of space objects, or { "spaces": [...] }.');
  }
  return list;
}

export function validate(data) {
  const object = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  };
  const string = (value, label, required = false) => {
    if (value == null && !required) return;
    if (typeof value !== "string" || value.includes("\0") || (required && !value.trim())) {
      throw new Error(`${label} must be ${required ? "a non-empty string" : "a string or null"}.`);
    }
  };
  object(data, "The config");
  string(data.name, "Space name", true);
  string(data.machine, "Space machine");
  if (Object.prototype.hasOwnProperty.call(data, "folder")) {
    throw new Error("Space folder is no longer supported. Move directories to panes[].working_dir (each tab's root sets its inherited directory).");
  }
  if (Object.prototype.hasOwnProperty.call(data, "id")) {
    throw new Error("Space id is no longer supported. Spaces are identified by name and machine; keep ids only on panes.");
  }
  if (!Array.isArray(data.tabs) || !data.tabs.length) throw new Error("The config has no tabs.");
  for (const tab of data.tabs) {
    object(tab, "Each tab");
    string(tab.name, "Tab name");
    const label = tab.name || "untitled";
    if (!Array.isArray(tab.panes) || !tab.panes.length) throw new Error(`Tab "${label}" has no panes.`);
    const index = new Map();
    for (let i = 0; i < tab.panes.length; i++) {
      const pane = tab.panes[i];
      object(pane, `Each pane in "${label}"`);
      string(pane.id, `Pane id in "${label}"`, true);
      for (const key of ["command", "working_dir", "split_from", "split"]) string(pane[key], `Pane "${pane.id}" ${key}`);
      if (index.has(pane.id)) throw new Error(`Duplicate pane id "${pane.id}" in "${label}".`);
      index.set(pane.id, i);
    }
    if (tab.panes.filter((p) => !p.split_from).length !== 1) {
      throw new Error(`Tab "${label}" needs exactly one pane without split_from.`);
    }
    for (const pane of tab.panes) {
      if (!pane.split_from) continue;
      if (!index.has(pane.split_from)) throw new Error(`Pane "${pane.id}" splits from unknown "${pane.split_from}".`);
      if (index.get(pane.split_from) >= index.get(pane.id)) throw new Error(`Pane "${pane.id}" must come after "${pane.split_from}".`);
      if (pane.split !== "right" && pane.split !== "down") throw new Error(`Pane "${pane.id}" needs split "right" or "down".`);
    }
  }
}
