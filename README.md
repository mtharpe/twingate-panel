# Twingate Panel

A GNOME Shell extension that controls the [Twingate](https://www.twingate.com/) VPN client from the top panel — toggle connect/disconnect, sign in, switch accounts, browse resources, and see live reachability with optional pings.

Fork of [urhend/twingate-panel](https://github.com/urhend/twingate-panel).

## Requirements

- GNOME Shell 50 or newer
- Twingate CLI installed at `/usr/bin/twingate` or `/usr/local/bin/twingate`, or set its path in Preferences (see [Twingate downloads](https://www.twingate.com/download))

That's it. The extension talks to the Twingate daemon through its user-accessible socket (`/run/twingate/auth.sock`) — no `sudo`, no `pkexec`, no polkit rule, no group membership required.

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
- **Notifications** — desktop notifications on connect / disconnect / error
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

## License

GPL-3.0-or-later. See `LICENSE`.
