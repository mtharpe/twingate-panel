// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TwingatePanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Twingate Panel',
            description: 'Behavior of the top-panel indicator.',
        });
        page.add(group);

        const pollRow = new Adw.SpinRow({
            title: 'Poll interval',
            subtitle: 'How often status and resources are refreshed, in seconds',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
        });
        settings.bind('poll-interval-seconds', pollRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(pollRow);

        const notificationsRow = new Adw.SwitchRow({
            title: 'Enable notifications',
            subtitle: 'Announce connection changes (connected/disconnected/error) that last 10 seconds. Changes you make from the panel stay quiet.',
        });
        settings.bind('notifications-enabled', notificationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(notificationsRow);

        const autoOpenRow = new Adw.SwitchRow({
            title: 'Auto-open sign-in URL',
            subtitle: 'When Twingate needs sign-in, open the auth URL in your default browser once per session.',
        });
        settings.bind('auth-auto-open', autoOpenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(autoOpenRow);

        const pingGroup = new Adw.PreferencesGroup({
            title: 'Resource pings',
            description: 'Reachability check for each resource in the dropdown, independent of the status poll interval.',
        });
        page.add(pingGroup);

        const pingEnabledRow = new Adw.SwitchRow({
            title: 'Enable pings',
            subtitle: 'Ping each resource periodically and show a reachability dot. Turn off to skip pinging entirely.',
        });
        settings.bind('ping-enabled', pingEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pingGroup.add(pingEnabledRow);

        const pingIntervalRow = new Adw.SpinRow({
            title: 'Ping interval',
            subtitle: 'How often, in seconds, resource reachability is re-checked',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 300, step_increment: 1}),
        });
        settings.bind('ping-interval-seconds', pingIntervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('ping-enabled', pingIntervalRow, 'sensitive', Gio.SettingsBindFlags.GET);
        pingGroup.add(pingIntervalRow);

        const cliGroup = new Adw.PreferencesGroup({
            title: 'Twingate CLI',
            description: 'Leave both empty unless the defaults don\'t work on your system.',
        });
        page.add(cliGroup);

        const pathRow = new Adw.EntryRow({
            title: 'CLI path (empty = find /usr/bin, /usr/local/bin or PATH)',
        });
        settings.bind('twingate-path', pathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        cliGroup.add(pathRow);

        const helperRow = new Adw.EntryRow({
            title: 'Privileged helper (pkexec; connect [account] | off | add)',
        });
        settings.bind('privileged-helper', helperRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        cliGroup.add(helperRow);
    }
}
