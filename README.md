# Tiiny Control Panel for Home Assistant

A Home Assistant add-on that runs the community
[Tiiny Control Panel](https://github.com/0xStian/tiiny-control-panel) and shows it in the Home Assistant sidebar.
Manage your Tiiny AI device (models, chat, firmware updates, log in after a restart) from Home Assistant, at home
or remotely through your normal Home Assistant login.

> **Independent packaging.** Not affiliated with Tiiny or with the panel's author. The panel is the work of
> [0xStian](https://github.com/0xStian/tiiny-control-panel) (MIT). Please report problems with this add-on
> [here](https://github.com/TheS1ngularity/TiinyControlPanel-HA/issues), not upstream.

## Install

[![Add this repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FTheS1ngularity%2FTiinyControlPanel-HA)

Or by hand:

1. Settings → Add-ons (Apps) → Store → ⋮ → **Repositories**, and add
   `https://github.com/TheS1ngularity/TiinyControlPanel-HA`
2. Install **Tiiny Control Panel**. The image is built on your machine, so the first install takes a few minutes.
3. Switch on **Show in sidebar**, then Start.
4. Open **Tiiny** in the sidebar → Network: type your Tiiny's address → Account → **Log in**.

## What you need

- Home Assistant OS or Supervised (add-ons are not available on Container or Core installs).
- A Tiiny that is activated and on the same network as Home Assistant, over Wi-Fi or a USB-C Ethernet adapter.
  Give it a fixed address in your router.
- Tested on amd64 (Intel/AMD). The add-on also builds for aarch64 (Raspberry Pi and similar), but that is untested.

## Read this before installing: who gets access

By default, **any Home Assistant administrator who opens the panel from the sidebar has full access to it**, with
no second sign-in. That includes the panel's terminal and everything it can do to your Tiiny. The original panel
makes every browser sign in separately; this add-on trusts Home Assistant's login instead, so that the sidebar and
remote access work.

- Use two-factor authentication in Home Assistant, especially if it is reachable from the internet.
- Non-admin users don't see the panel.
- To get the original behaviour back, switch off **Trust the Home Assistant login** in the add-on's Configuration.

## Options

| Option | Default | What it does |
|---|---|---|
| Trust the Home Assistant login | on | See above. |
| Gateway: accept any numeric address | on | Lets apps on other machines use the panel's gateway at `http://<HA address>:8766`. |
| Let the agent run commands | off | The panel's agent may run commands inside the add-on's container, after your OK each time. |
| Extra host names | none | Names used to open the panel directly on port 8765. |
| Log every request | off | Troubleshooting. |

Details, ports and how apps connect: [tiiny_panel/DOCS.md](tiiny_panel/DOCS.md).

## What is different from the original panel

The add-on carries an unmodified copy of the panel (in `tiiny_panel/panel/`) and applies a few small edits when the
image is built (`tiiny_panel/ha/patch_for_ha.py`). Each edit must match exactly, or the build stops.

- Requests that arrive through Home Assistant's sidebar proxy (Ingress) count as signed in (optional).
- The page may be shown inside Home Assistant's frame, and its requests get the sidebar's path prefix.
- Request bodies that Home Assistant sends in chunks are read correctly.
- The gateway can accept requests addressed to Home Assistant's address (optional).
- HTTPS on the direct port is off; inside Home Assistant the connection is as secure as your Home Assistant address.

## Known limits

- **"Find my Tiiny" doesn't find it.** The add-on isn't on the host network. Type the address.
- **No USB-C connection** to the Tiiny from the Home Assistant machine.
- **After every restart or power cut the Tiiny locks itself** until someone logs in. That is the device's design.
  The panel's Log in button does it.
- **No "install as an app"** when opened inside Home Assistant.
- **Microphone features** (dictation, live meeting notes) are untested inside Home Assistant's frame and may not work.
- **Panel updates are manual.** The add-on's version says which panel it contains (`1.4.1-ha4` is panel 1.4.1,
  add-on revision 4). A new panel release needs a new add-on release; the panel's own updater is not used.

## Your data

Chats, settings, and the key the panel uses for your Tiiny are stored in the add-on's data folder and are included
in Home Assistant backups. Nothing is sent anywhere except to your Tiiny, and to Tiiny's servers when the add-on
installs Tiiny's command-line tool on first start.

## Licence

This repository is MIT-licensed. The Tiiny Control Panel is © its author, MIT-licensed; its licence and third-party
notices are in `tiiny_panel/panel/`.
