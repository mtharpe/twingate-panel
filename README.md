# Twingate Panel

A GNOME Shell extension that controls the [Twingate](https://www.twingate.com/) VPN client from the top panel — toggle connect/disconnect, sign in, switch accounts, browse resources, and see live reachability with optional pings.

Fork of [urhend/twingate-panel](https://github.com/urhend/twingate-panel).

## Requirements

- GNOME Shell 50 or newer
- Twingate CLI installed at `/usr/bin/twingate` or `/usr/local/bin/twingate`, or set its path in Preferences (see [Twingate downloads](https://www.twingate.com/download))

That's it. The extension talks to the Twingate daemon through its user-accessible socket (`/run/twingate/auth.sock`) — no `sudo`, no `pkexec`, no polkit rule, no group membership required.

(The one exception is if you disable Twingate's autostart so it runs only on demand — starting the
system daemon then needs a small polkit rule; see
[Starting the daemon on demand](#starting-the-daemon-on-demand-autostart-disabled).)

## Install

**From extensions.gnome.org:** search for "Twingate Panel" and click Install. Nothing else to do.

**From source:**

```sh
git clone https://github.com/mtharpe/twingate-panel.git
ln -s "$PWD/twingate-panel" ~/.local/share/gnome-shell/extensions/twingate-panel@mtharpe
glib-compile-schemas twingate-panel/schemas
# then log out / back in (Wayland) or Alt+F2 → r (X11), and enable it:
gnome-extensions enable twingate-panel@mtharpe
```

## Usage

Click the Twingate icon in the top panel.

- **Toggle** — connect / disconnect
- **Sign in** — appears when Twingate is waiting for browser auth
- **Reconnect** — force reconnect (useful after network changes)
- **Accounts** — switch between signed-in accounts, add, or log out
- **Resources** — searchable list of the network resources available to you, with an optional per-resource ping dot

## Preferences

Open with the gear icon in the panel menu or via `gnome-extensions prefs twingate-panel@mtharpe`.

- **Poll interval** — how often to refresh Twingate status
- **Ping enabled / interval** — background reachability checks for each resource
- **Notifications** — desktop notifications on connect / disconnect / error, only once a change has lasted 10 seconds and not for changes you start from the panel
- **Auto-open auth URL** — automatically open the Twingate sign-in URL in your browser when authentication is required
- **CLI path** — where the `twingate` command is; empty checks `/usr/bin`, `/usr/local/bin`, then `PATH`
- **Privileged helper** — optional; see below

### Privileged helper (optional)

On systems where the Twingate CLI can't get root for itself, such as image-based distros
without `sudo`, point **Privileged helper** at a root-owned script. The panel then runs it with
`pkexec` for these actions instead of calling `twingate` directly:

| Panel action | Helper call |
|---|---|
| Toggle on | `connect` (or `connect <email>` when the active account is known) |
| Toggle off | `off` |
| Pick an account | `connect <email>` |
| Add account… | `add` (in a terminal) |

Pair it with a polkit rule allowing `org.freedesktop.policykit.exec` for that one program if
you don't want a password prompt. Leave the setting empty to keep the default behaviour.

The active account is taken from the CLI's `account list` when it marks one, otherwise from
the client's active profile in `/var/lib/twingate/profiles`.

### Starting the daemon on demand (autostart disabled)

If you turn off Twingate's autostart — e.g. `sudo systemctl disable twingate.service` — so it
only runs when you need it, the panel's **Connect** toggle can no longer start the daemon by
itself: `twingate start` calls `systemctl start twingate`, and `twingate.service` is a system
service that normally asks for a password. With the daemon stopped, **Connect** would prompt for
(or, from a non-interactive context, fail on) authentication.

To let the panel start and stop the daemon on demand without a prompt, add a polkit rule scoped
to your user and that one unit:

```js
// /etc/polkit-1/rules.d/60-twingate-panel.rules
polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        action.lookup("unit") == "twingate.service" &&
        subject.user == "YOUR_USERNAME" &&
        subject.local && subject.active) {
        return polkit.Result.YES;
    }
});
```

Replace `YOUR_USERNAME` and reload polkit:

```sh
sudo systemctl restart polkit.service
```

This grants passwordless start/stop of `twingate.service` to that one user, in a local active
session — nothing else. **Connect** then brings the daemon up, and **Disconnect** (`twingate
stop`) shuts it back down, so it is fully off when you are not using it. If you would rather not
add the rule, use the privileged helper above or expect a password dialog on each connect.

## License

GPL-3.0-or-later. See `LICENSE`.
