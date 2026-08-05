// SPDX-License-Identifier: GPL-3.0-or-later
// Twingate Panel — GNOME Shell extension
// Copyright (C) 2026 the Twingate Panel contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// any later version. See the LICENSE file for details.

import GObject from "gi://GObject";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

Gio._promisify(Gio.Subprocess.prototype, "communicate_utf8_async");

const TWINGATE_BIN = "/usr/bin/twingate";
const TERMINAL_CANDIDATES = [
  "ptyxis",
  "kgx",
  "gnome-terminal",
  "konsole",
  "xterm",
];

const STATUS_INFO = {
  "not-running": { label: "Not running", connected: false, dotColor: "#9a9996" },
  offline: { label: "Offline", connected: false, dotColor: "#9a9996" },
  online: { label: "Online", connected: true, dotColor: "#33d17a" },
  connecting: { label: "Connecting…", connected: false, dotColor: "#f5c211" },
  authenticating: {
    label: "Authenticating…",
    connected: false,
    dotColor: "#f5c211",
  },
  unknown: { label: "Unknown", connected: false, dotColor: "#9a9996" },
};

const NOTIFY_CATEGORY = {
  online: "connected",
  "not-running": "disconnected",
  offline: "disconnected",
  unknown: "error",
};

const PING_CLASSES = [
  "twingate-dot-pending",
  "twingate-dot-reachable",
  "twingate-dot-unreachable",
];
const DOT_SIZE = 7;
const BACKGROUND_POLL_MULTIPLIER = 6;

function createDot(extraClass) {
  const dot = new St.Widget({
    style_class: `twingate-status-dot ${extraClass}`,
    x_expand: false,
    y_expand: false,
    y_align: Clutter.ActorAlign.CENTER,
  });
  dot.set_size(DOT_SIZE, DOT_SIZE);
  return dot;
}

function statusInfoFor(token) {
  return STATUS_INFO[token] ?? STATUS_INFO.unknown;
}

async function runCommand(argv, cancellable) {
  let proc;
  try {
    proc = new Gio.Subprocess({
      argv,
      flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    proc.init(cancellable);
  } catch (e) {
    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
    return { success: false, stdout: "", stderr: e.message ?? String(e) };
  }

  try {
    const [stdout, stderr] = await proc.communicate_utf8_async(
      null,
      cancellable,
    );
    return {
      success: proc.get_successful(),
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    };
  } catch (e) {
    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
    return { success: false, stdout: "", stderr: e.message ?? String(e) };
  }
}

function parseStatusToken(stdout) {
  const firstLine =
    (stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const token = firstLine.toLowerCase().split(/\s+/)[0] ?? "";
  return token in STATUS_INFO ? token : "unknown";
}

function parseAuthUrl(stdout) {
  const lines = (stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    if (line.startsWith("https://") || line.startsWith("http://"))
      return line;
  }
  return null;
}

function extractAuthSessionId(url) {
  if (!url) return null;
  const m = url.match(/auth_session_id[=%3D]+([A-Za-z0-9_-]+)/);
  return m ? m[1] : url;
}

async function pingAddress(address, cancellable) {
  try {
    const result = await runCommand(
      ["ping", "-c", "1", "-W", "1", address],
      cancellable,
    );
    return result.success;
  } catch (e) {
    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
    return false;
  }
}

function parseAccounts(stdout) {
  const lines = (stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows = [];
  for (const line of lines) {
    const fields = line.split("\t").map((f) => f.trim());
    if (fields.length < 2 || /^email$/i.test(fields[0])) continue;
    rows.push({
      email: fields[0],
      network: fields[1] ?? "",
      url: fields[2] ?? "",
      current: fields[3] === "*",
    });
  }
  return rows;
}

function parseNetworkNameFromAccounts(accounts) {
  if (accounts.length === 0) return null;
  const current = accounts.find((a) => a.current);
  return (current ?? accounts[0]).network;
}

const VALID_ADDRESS_RE = /^[*A-Za-z0-9][*A-Za-z0-9.:/_-]*$/;

function isPingable(address) {
  return !address.includes("*") && !address.includes("/");
}

function parseResources(stdout) {
  const lines = (stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows = [];
  for (const line of lines) {
    const fields = line.split("\t").map((f) => f.trim());
    if (fields.length < 2 || /^resource name$/i.test(fields[0])) continue;
    const address = fields[1];
    if (!VALID_ADDRESS_RE.test(address)) continue;
    rows.push({ name: fields[0], address });
  }
  return rows;
}

function findTerminal() {
  for (const t of TERMINAL_CANDIDATES) {
    if (GLib.find_program_in_path(t)) return t;
  }
  return null;
}

function terminalArgv(terminal, cmdArgv) {
  if (terminal === "xterm" || terminal === "konsole")
    return [terminal, "-e", ...cmdArgv];
  return [terminal, "--", ...cmdArgv];
}

function spawnDetached(argv) {
  try {
    GLib.spawn_async(
      null,
      argv,
      null,
      GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
      null,
    );
    return true;
  } catch (e) {
    return false;
  }
}

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(extensionPath, settings, onOpenPreferences) {
      super._init(0.0, "Twingate Panel", false);

      this._extensionPath = extensionPath;
      this._settings = settings;
      this._onOpenPreferences = onOpenPreferences;
      this._cancellable = new Gio.Cancellable();
      this._timeoutId = null;
      this._pingTimeoutId = null;
      this._pendingRefreshIds = new Set();
      this._suppressToggle = false;
      this._busy = false;
      this._resourceGeneration = 0;
      this._resourceDots = new Map();
      this._allResources = [];
      this._resourceFilter = "";
      this._searchToggledOn = false;
      this._pingStatus = new Map();
      this._previousCategory = null;
      this._connected = false;
      this._authUrl = null;
      this._lastAutoOpenedSessionId = null;
      this._accounts = [];
      this._currentToken = "unknown";

      const iconPath = GLib.build_filenamev([
        extensionPath,
        "icons",
        "twingate-panel.png",
      ]);
      this._icon = new St.Icon({
        gicon: Gio.icon_new_for_string(iconPath),
        icon_size: 16,
      });
      this.add_child(this._icon);

      this._buildMenu();
      this._setState("unknown");

      this._refresh();
      this._refreshAccounts();
      this._startPolling();
      this._startPingPolling();

      this._menuOpenStateId = this.menu.connect(
        "open-state-changed",
        (_menu, isOpen) => {
          if (isOpen) {
            this._refresh();
            this._refreshAccounts();
          } else {
            this._setSearchVisible(false);
          }
          this._startPolling();
        },
      );
      this._settingsChangedId = this._settings.connect(
        "changed::poll-interval-seconds",
        () => {
          this._startPolling();
        },
      );
      this._pingSettingsChangedId = this._settings.connect(
        "changed::ping-enabled",
        () => {
          this._startPingPolling();
          this._refreshResources();
        },
      );
      this._pingIntervalChangedId = this._settings.connect(
        "changed::ping-interval-seconds",
        () => {
          this._startPingPolling();
        },
      );
    }

    _startPolling() {
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }
      const base = this._settings.get_int("poll-interval-seconds");
      const seconds = this.menu.isOpen ? base : base * BACKGROUND_POLL_MULTIPLIER;
      this._timeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        seconds,
        () => {
          this._refresh();
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    _startPingPolling() {
      if (this._pingTimeoutId) {
        GLib.Source.remove(this._pingTimeoutId);
        this._pingTimeoutId = null;
      }
      if (!this._settings.get_boolean("ping-enabled")) return;

      const seconds = this._settings.get_int("ping-interval-seconds");
      this._pingTimeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        seconds,
        () => {
          this._pingAllResources(this._resourceGeneration);
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    _pingAllResources(generation) {
      for (const { address } of this._allResources) {
        if (generation !== this._resourceGeneration) return;
        if (!isPingable(address)) continue;
        pingAddress(address, this._cancellable)
          .then((reachable) => {
            if (generation !== this._resourceGeneration) return;
            this._pingStatus.set(address, reachable);
            const dot = this._resourceDots.get(address);
            if (dot) {
              for (const cls of PING_CLASSES) dot.remove_style_class_name(cls);
              dot.add_style_class_name(
                reachable
                  ? "twingate-dot-reachable"
                  : "twingate-dot-unreachable",
              );
            }
          })
          .catch(() => {});
      }
    }

    _buildMenu() {
      const headerItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const headerBox = new St.BoxLayout({
        style_class: "twingate-header-box",
        x_expand: true,
      });

      this._networkNameLabel = new St.Label({
        style_class: "twingate-network-title",
        text: "Twingate",
        y_align: Clutter.ActorAlign.CENTER,
      });
      headerBox.add_child(this._networkNameLabel);

      this._statusDot = createDot("");
      headerBox.add_child(this._statusDot);

      const spacer = new St.Widget({ x_expand: true });
      headerBox.add_child(spacer);

      const settingsButton = new St.Button({
        style_class: "twingate-settings-button",
        y_align: Clutter.ActorAlign.START,
        child: new St.Icon({
          icon_name: "preferences-system-symbolic",
          style_class: "popup-menu-icon twingate-header-icon",
        }),
      });
      settingsButton.connect("clicked", () => {
        this.menu.close();
        this._onOpenPreferences();
      });
      headerBox.add_child(settingsButton);

      headerItem.add_child(headerBox);
      this.menu.addMenuItem(headerItem);

      this._switchItem = new PopupMenu.PopupSwitchMenuItem("Connected", false);
      this._switchItem.connect("toggled", (_item, state) => {
        if (this._suppressToggle) return;
        this._onToggle(state);
      });
      this.menu.addMenuItem(this._switchItem);

      this._signinItem = new PopupMenu.PopupMenuItem("Sign in to Connect");
      this._signinItem.connect("activate", () => {
        this.menu.close();
        this._openAuthUrl();
      });
      this._signinItem.visible = false;
      this.menu.addMenuItem(this._signinItem);

      this._reconnectItem = new PopupMenu.PopupMenuItem("Reconnect");
      this._reconnectItem.connect("activate", () => {
        this.menu.close();
        this._runReconnect();
      });
      this._reconnectItem.visible = false;
      this.menu.addMenuItem(this._reconnectItem);

      this._accountsSeparator = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._accountsSeparator);

      this._accountsMenu = new PopupMenu.PopupSubMenuMenuItem("Accounts", false);
      this.menu.addMenuItem(this._accountsMenu);

      this._resourcesSeparator = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._resourcesSeparator);

      this._resourcesHeader = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: false,
        activate: false,
      });
      const resourcesHeaderBox = new St.BoxLayout({ x_expand: true });

      const resourcesLabel = new St.Label({
        style_class: "twingate-resources-header",
        text: "Resources",
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      resourcesHeaderBox.add_child(resourcesLabel);

      const searchToggleButton = new St.Button({
        style_class: "twingate-settings-button",
        child: new St.Icon({
          icon_name: "edit-find-symbolic",
          style_class: "popup-menu-icon twingate-header-icon",
        }),
      });
      searchToggleButton.connect("clicked", () => {
        this._setSearchVisible(!this._resourceSearchItem.visible);
      });
      resourcesHeaderBox.add_child(searchToggleButton);

      this._resourcesHeader.add_child(resourcesHeaderBox);
      this._resourcesHeader.visible = false;
      this.menu.addMenuItem(this._resourcesHeader);

      const searchItem = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: false,
        activate: false,
      });
      this._searchEntry = new St.Entry({
        style_class: "twingate-search-entry",
        hint_text: "Search resources…",
        x_expand: true,
        can_focus: true,
      });
      this._searchEntry.clutter_text.connect("text-changed", () => {
        this._resourceFilter = this._searchEntry
          .get_text()
          .trim()
          .toLowerCase();
        this._renderResourceItems();
      });
      searchItem.add_child(this._searchEntry);
      searchItem.visible = false;
      this.menu.addMenuItem(searchItem);
      this._resourceSearchItem = searchItem;

      this._resourcesSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._resourcesSection);
    }

    _setState(token) {
      this._currentToken = token;
      const info = statusInfoFor(token);
      this._connected = info.connected;

      this._statusDot.set_style(`background-color: ${info.dotColor};`);

      if (info.connected)
        this._networkNameLabel.add_style_class_name(
          "twingate-network-title-connected",
        );
      else
        this._networkNameLabel.remove_style_class_name(
          "twingate-network-title-connected",
        );

      this._suppressToggle = true;
      this._switchItem.setToggleState(info.connected);
      this._suppressToggle = false;

      const canReconnect = token === "online" || token === "offline";
      this._reconnectItem.visible = canReconnect;
    }

    _setResources(resources) {
      this._allResources = resources;
      if (resources.length === 0) this._pingStatus.clear();
      this._renderResourceItems();

      const pingEnabled = this._settings.get_boolean("ping-enabled");
      if (pingEnabled && resources.length > 0)
        this._pingAllResources(this._resourceGeneration);
    }

    _setSearchVisible(visible) {
      this._searchToggledOn = visible;
      if (!visible) this._searchEntry.set_text("");
      this._resourceSearchItem.visible =
        visible && this._allResources.length > 0;
      if (visible) this._searchEntry.grab_key_focus();
    }

    _renderResourceItems() {
      this._resourcesSection.removeAll();

      const hasResources = this._allResources.length > 0;
      const showEmptyPlaceholder = this._connected && !hasResources;
      this._resourcesHeader.visible = hasResources || showEmptyPlaceholder;
      this._resourceSearchItem.visible = hasResources && this._searchToggledOn;

      this._resourceGeneration++;
      this._resourceDots.clear();

      const pingEnabled = this._settings.get_boolean("ping-enabled");
      const filter = this._resourceFilter;
      const filtered = filter
        ? this._allResources.filter(({ name, address }) =>
            `${name} ${address}`.toLowerCase().includes(filter),
          )
        : this._allResources;

      if (showEmptyPlaceholder) {
        const emptyItem = new PopupMenu.PopupBaseMenuItem({
          reactive: false,
          can_focus: false,
        });
        emptyItem.add_child(
          new St.Label({
            style_class: "twingate-resource-empty",
            text: "No resources available",
            x_expand: true,
          }),
        );
        this._resourcesSection.addMenuItem(emptyItem);
      }

      for (const { name, address } of filtered) {
        const item = new PopupMenu.PopupBaseMenuItem({
          reactive: false,
          can_focus: false,
        });
        const box = new St.BoxLayout({
          style_class: "twingate-resource-box",
          x_expand: true,
        });

        const label = new St.Label({
          style_class: "twingate-resource-label",
          text: `${name} · ${address}`,
          y_align: Clutter.ActorAlign.CENTER,
          x_expand: true,
        });
        box.add_child(label);

        const status = this._pingStatus.get(address);
        const pingClass =
          status === true
            ? "twingate-dot-reachable"
            : status === false
              ? "twingate-dot-unreachable"
              : "twingate-dot-pending";
        const pingDot = createDot(pingClass);
        const showDot = pingEnabled && isPingable(address);
        pingDot.visible = showDot;
        box.add_child(pingDot);

        item.add_child(box);
        this._resourcesSection.addMenuItem(item);

        if (showDot) this._resourceDots.set(address, pingDot);
      }
    }

    _renderAccountsMenu() {
      const sub = this._accountsMenu.menu;
      sub.removeAll();

      if (this._accounts.length === 0) {
        const emptyItem = new PopupMenu.PopupMenuItem("No accounts");
        emptyItem.setSensitive(false);
        sub.addMenuItem(emptyItem);
      } else {
        for (const acct of this._accounts) {
          const label = acct.network
            ? `${acct.email}  ·  ${acct.network}`
            : acct.email;
          const item = new PopupMenu.PopupMenuItem(label);
          if (acct.current) item.setOrnament(PopupMenu.Ornament.DOT);
          item.connect("activate", () => {
            this.menu.close();
            this._switchAccount(acct.email);
          });
          sub.addMenuItem(item);
        }
      }

      sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      const addItem = new PopupMenu.PopupMenuItem("Add account…");
      addItem.connect("activate", () => {
        this.menu.close();
        this._addAccount();
      });
      sub.addMenuItem(addItem);

      if (this._accounts.length > 0) {
        const logoutItem = new PopupMenu.PopupMenuItem("Log out");
        logoutItem.connect("activate", () => {
          this.menu.close();
          this._logoutAccount();
        });
        sub.addMenuItem(logoutItem);
      }
    }

    _onToggle(wantConnected) {
      if (wantConnected) this._runStart();
      else this._runStop();
    }

    async _runTwingate(args) {
      if (this._busy) return;
      this._busy = true;
      try {
        await runCommand([TWINGATE_BIN, ...args], this._cancellable);
      } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      } finally {
        this._busy = false;
      }
      this._scheduleQuickRefreshes();
    }

    _runStart() {
      return this._runTwingate(["start"]);
    }

    _runStop() {
      return this._runTwingate(["stop"]);
    }

    async _runReconnect() {
      if (this._busy) return;
      this._busy = true;
      try {
        if (this._currentToken === "online")
          await runCommand([TWINGATE_BIN, "disconnect"], this._cancellable);
        await runCommand([TWINGATE_BIN, "connect"], this._cancellable);
      } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      } finally {
        this._busy = false;
      }
      this._scheduleQuickRefreshes();
    }

    async _runTwingateConfirming(twingateArgs, positionalArgs = []) {
      if (this._busy) return;
      this._busy = true;
      try {
        const placeholders = positionalArgs
          .map((_, i) => `"$${i + 1}"`)
          .join(" ");
        const script = `yes | ${TWINGATE_BIN} ${twingateArgs.join(" ")} ${placeholders}`.trim();
        await runCommand(
          ["sh", "-c", script, "_", ...positionalArgs],
          this._cancellable,
        );
      } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      } finally {
        this._busy = false;
      }
      this._scheduleQuickRefreshes();
    }

    async _switchAccount(email) {
      await this._runTwingateConfirming(["-d", "account", "switch"], [email]);
      this._refreshAccounts();
    }

    async _logoutAccount() {
      await this._runTwingateConfirming(["-d", "account", "logout"]);
      this._refreshAccounts();
    }

    _addAccount() {
      const term = findTerminal();
      if (!term) {
        Main.notifyError(
          "Twingate",
          "No terminal found. Install ptyxis, gnome-terminal, konsole, or xterm.",
        );
        return;
      }
      const argv = terminalArgv(term, [TWINGATE_BIN, "account", "add"]);
      if (!spawnDetached(argv))
        Main.notifyError(
          "Twingate",
          "Failed to launch terminal for account setup.",
        );
    }

    _scheduleQuickRefreshes() {
      for (const delay of [2, 5]) {
        const id = GLib.timeout_add_seconds(
          GLib.PRIORITY_DEFAULT,
          delay,
          () => {
            this._pendingRefreshIds.delete(id);
            this._refresh();
            this._refreshAccounts();
            return GLib.SOURCE_REMOVE;
          },
        );
        this._pendingRefreshIds.add(id);
      }
    }

    async _refresh() {
      let result;
      try {
        result = await runCommand(
          [TWINGATE_BIN, "-d", "status"],
          this._cancellable,
        );
      } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        this._setState("unknown");
        this._maybeNotifyStateChange("unknown");
        return;
      }

      if (!result.success && result.stdout.length === 0) {
        this._setState("unknown");
        this._maybeNotifyStateChange("unknown");
        return;
      }

      const token = parseStatusToken(result.stdout);
      const url =
        token === "authenticating" ? parseAuthUrl(result.stdout) : null;
      this._authUrl = url;
      this._signinItem.visible = !!url;

      if (url && this._settings.get_boolean("auth-auto-open")) {
        const sid = extractAuthSessionId(url);
        if (sid && sid !== this._lastAutoOpenedSessionId) {
          this._lastAutoOpenedSessionId = sid;
          this._openAuthUrl();
        }
      }
      if (token !== "authenticating") this._lastAutoOpenedSessionId = null;

      this._setState(token);
      this._maybeNotifyStateChange(token);

      if (statusInfoFor(token).connected) this._refreshResources();
      else this._setResources([]);
    }

    _maybeNotifyStateChange(token) {
      const category = NOTIFY_CATEGORY[token] ?? null;
      if (
        category &&
        this._previousCategory !== null &&
        category !== this._previousCategory &&
        this._settings.get_boolean("notifications-enabled")
      ) {
        const network = this._networkNameLabel.text || "Twingate";
        if (category === "connected")
          Main.notify("Twingate", `Connected to ${network}`);
        else if (category === "disconnected")
          Main.notify("Twingate", "Disconnected");
        else if (category === "error")
          Main.notifyError(
            "Twingate",
            "Something went wrong — check the connection status.",
          );
      }
      if (category) this._previousCategory = category;
    }

    _openAuthUrl() {
      if (!this._authUrl) return;
      runCommand(["xdg-open", this._authUrl], this._cancellable).catch(() => {});
    }

    async _refreshAccounts() {
      let result;
      try {
        result = await runCommand(
          [TWINGATE_BIN, "-d", "account", "list"],
          this._cancellable,
        );
      } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        return;
      }
      this._accounts = parseAccounts(result.stdout);
      const name = parseNetworkNameFromAccounts(this._accounts);
      this._networkNameLabel.text = name ?? "Twingate";
      this._renderAccountsMenu();
    }

    async _refreshResources() {
      let result;
      try {
        result = await runCommand(
          [TWINGATE_BIN, "-d", "resources"],
          this._cancellable,
        );
      } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        this._setResources([]);
        return;
      }

      this._setResources(parseResources(result.stdout));
    }

    destroy() {
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }
      if (this._pingTimeoutId) {
        GLib.Source.remove(this._pingTimeoutId);
        this._pingTimeoutId = null;
      }
      for (const id of this._pendingRefreshIds) GLib.Source.remove(id);
      this._pendingRefreshIds.clear();
      this._resourceDots.clear();

      if (this._menuOpenStateId) {
        this.menu.disconnect(this._menuOpenStateId);
        this._menuOpenStateId = null;
      }
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
      }
      if (this._pingSettingsChangedId) {
        this._settings.disconnect(this._pingSettingsChangedId);
        this._pingSettingsChangedId = null;
      }
      if (this._pingIntervalChangedId) {
        this._settings.disconnect(this._pingIntervalChangedId);
        this._pingIntervalChangedId = null;
      }

      this._cancellable.cancel();

      super.destroy();
    }
  },
);

export default class TwingatePanelExtension extends Extension {
  enable() {
    this._indicator = new Indicator(this.path, this.getSettings(), () =>
      this.openPreferences(),
    );
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
