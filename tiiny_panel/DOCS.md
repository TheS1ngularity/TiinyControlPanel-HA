# Tiiny Control Panel for Home Assistant

A local add-on that runs the community Tiiny Control Panel (1.4.1) and shows it in the Home Assistant sidebar.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories**: add this repository's URL.
2. Install **Tiiny Control Panel** (the first build takes a few minutes), switch on **Show in sidebar**, then Start.
3. Open **Tiiny** in the sidebar → Network: enter your Tiiny's address (give it a fixed address in your router) → Account → Log in.

## How access works

- **Inside Home Assistant (sidebar, also remotely):** with **Trust the Home Assistant login** on (the default) there
  is no separate sign-in. Anyone who reaches the panel through Home Assistant gets full access, including its
  terminal, so use two-factor authentication in Home Assistant. Only administrators see it in the sidebar, but
  treat every Home Assistant login as able to open it. Switch the option off and every browser signs in to the
  panel itself.
- **Directly on port 8765:** off by default. If you map the port (Configuration → Network), it is plain HTTP and
  each browser signs in with a link from System → Devices → Add a device.
- **Gateway on port 8766 (optional):** gives each app its own limited key and loads models on demand. In the panel:
  Integrations → switch on "Apps on other computers", then add an app to get its key. Apps use
  `http://<HA address>:8766`. Apps can also skip the gateway and talk to the Tiiny directly on port 80 with the
  device key; that key can manage the whole device, so prefer an app key where you can.

## Options

| Option | Default | What it does |
|---|---|---|
| Trust the Home Assistant login | on | See above. |
| Gateway: accept any numeric address | on | Lets apps on other machines use the gateway at `http://<HA address>:8766`. Off restores the original panel's check, which inside an add-on only Home Assistant itself can pass. |
| Unlock the Tiiny automatically | off | After the Tiiny restarts, unlocks it with the key saved at your last log in. Checks once a minute; stops after three failed attempts. |
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
