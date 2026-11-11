# Tiiny Control Panel for Home Assistant

A local add-on that runs the community Tiiny Control Panel (1.4.1) and shows it in the Home Assistant sidebar.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories**: add this repository's URL.
2. Install **Tiiny Control Panel** (the first build takes a few minutes), switch on **Show in sidebar**, then Start.
3. Open **Tiiny** in the sidebar → Network: enter your Tiiny's address (give it a fixed address in your router) → Account → Log in.

## How access works

- **Inside Home Assistant (sidebar, also remotely):** with **Trust the Home Assistant login** on (the default) there
  is no separate sign-in. Any Home Assistant **admin** gets full access to the panel, including its terminal, so use
  two-factor authentication in Home Assistant. Non-admin users don't see it. Switch the option off and every browser
  signs in to the panel itself.
- **Directly on port 8765:** off by default. If you map the port (Configuration → Network), it is plain HTTP and
  each browser signs in with a link from System → Devices → Add a device.
- **Gateway on port 8766:** for apps. In the panel: Integrations → switch on "Apps on other computers", then add
  an app to get its key. Home Assistant itself reaches it at `http://<HA address>:8766`.

## Options

| Option | Default | What it does |
|---|---|---|
| Trust the Home Assistant login | on | See above. |
| Let the agent run commands | off | The agent may run commands inside the add-on's container, after your OK each time. |
| Extra host names | none | Names used to open the panel directly on port 8765. |
| Log every request | off | Troubleshooting. |

## Not available in this build

- "Find my Tiiny" network scan (the add-on isn't on the host network). Type the address instead.
- USB-C connection to the Tiiny.
- Install as an app / offline service worker, when opened inside Home Assistant.

## Updating the panel

Replace the contents of `panel/` with the new upstream `tiiny_ui.py`, `tiinyui/`, `static/` and
`docker/entrypoint.sh`, raise `version` in `config.yaml`, then Rebuild the add-on. If the build stops with
`patch_for_ha: expected 1 match(es)`, the upstream code moved and `ha/patch_for_ha.py` needs adjusting.

## Data

Everything (chats, settings, Tiiny's command-line tool and its login key) is in the add-on's `/data` and is
included in Home Assistant backups.
