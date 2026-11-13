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

By default, **anyone who reaches the panel through Home Assistant has full access to it**, with
no second sign-in. That includes the panel's terminal and everything it can do to your Tiiny. The original panel
makes every browser sign in separately; this add-on trusts Home Assistant's login instead, so that the sidebar and
remote access work.

- Use two-factor authentication in Home Assistant, especially if it is reachable from the internet.
- The sidebar entry is shown to administrators only. That hides the panel from other users; it may not stop one
  who opens its address directly, so don't rely on it as protection.
- If people you wouldn't hand a terminal to have a login on your Home Assistant (guests, children), switch off
  **Trust the Home Assistant login**.
- To get the original behaviour back, switch off **Trust the Home Assistant login** in the add-on's Configuration.

## Options

| Option | Default | What it does |
|---|---|---|
| Trust the Home Assistant login | on | See above. |
| Gateway: accept any numeric address | on | Lets apps on other machines use the panel's gateway at `http://<HA address>:8766`. |
| Unlock the Tiiny automatically | off | After the Tiiny restarts, unlocks it with the key saved at your last log in. See below. |
| Tiiny password | empty | Optional fallback for automatic unlock when the saved key is refused. See below. |
| Let the agent run commands | off | The panel's agent may run commands inside the add-on's container, after your OK each time. |
| Extra host names | none | Names used to open the panel directly on port 8765. |
| Log every request | off | Troubleshooting. |

Details, ports and how apps connect: [tiiny_panel/DOCS.md](tiiny_panel/DOCS.md).

## After a restart: unlock and load models automatically

A Tiiny locks its data every time it restarts, and its models are unloaded. Until someone logs in, nothing works.
The add-on can do both steps for you.

**How unlocking works.** There is one way to unlock: with a key. Your password is only how you get a key.

1. You log in once in the panel (Account → Log in). The Tiiny hands out a key and the panel saves it.
2. With **Unlock the Tiiny automatically** on, the add-on checks once a minute. If the Tiiny is locked, it sends the saved key.
3. If the Tiiny refuses the key and you filled in **Tiiny password**, the add-on logs in with it once, saves the new
   key and unlocks. Without a password you log in by hand, once, and automatic unlock works again.

The saved key survives restarts of the Tiiny, the add-on and Home Assistant. It may stop working after a password
change or a TiinyOS update. The add-on tries the key three times and the password once per lock, then stops and
writes the Tiiny's answer to the add-on log.

**How loading models works.** In the panel, press **Auto-load** (top bar) and tick the models you want. They are
loaded top to bottom whenever the Tiiny is unlocked again after being locked or unreachable, whether the add-on or
you unlocked it. "Save and load now" tries it straight away. Pick only what fits in the Tiiny's memory together.

**What to weigh up.**

- With automatic unlock on, anyone who can power the Tiiny on inside your network gets an unlocked device.
- The password is optional. It is stored unencrypted in the add-on's options and in Home Assistant backups, and
  every Home Assistant administrator can read it. Leave it empty if the saved key is enough for you.

## What is different from the original panel

The add-on carries an unmodified copy of the panel (in `tiiny_panel/panel/`) and applies a few small edits when the
image is built (`tiiny_panel/ha/patch_for_ha.py`). Each edit must match exactly, or the build stops.

- Requests that arrive through Home Assistant's sidebar proxy (Ingress) count as signed in (optional).
- The page may be shown inside Home Assistant's frame, and its requests get the sidebar's path prefix.
- Request bodies that Home Assistant sends in chunks are read correctly.
- The gateway can accept requests addressed to Home Assistant's address (optional).
- Automatic unlock and the **Auto-load** button are additions of this add-on (`tiiny_panel/ha/ha_watch.py`, `ha-autoload.js`).
- HTTPS on the direct port is off; inside Home Assistant the connection is as secure as your Home Assistant address.

## Known limits

- **"Find my Tiiny" doesn't find it.** The add-on isn't on the host network. Type the address.
- **No USB-C connection** to the Tiiny from the Home Assistant machine.
- **After every restart or power cut the Tiiny locks itself** until someone logs in. That is the device's design.
  The panel's Log in button does it, or let the add-on do it (see above).
- **No "install as an app"** when opened inside Home Assistant.
- **Microphone features** (dictation, live meeting notes) are untested inside Home Assistant's frame and may not work.
- **Panel updates are manual.** The add-on's version says which panel it contains (`1.4.1-ha6` is panel 1.4.1,
  add-on revision 6). A new panel release needs a new add-on release; the panel's own updater is not used.

## Your data

Chats, settings, the key the panel uses for your Tiiny, and the optional password are stored in the add-on's data folder and are included
in Home Assistant backups. Nothing is sent anywhere except to your Tiiny, and to Tiiny's servers when the add-on
installs Tiiny's command-line tool on first start.

## Licence

This repository is MIT-licensed. The Tiiny Control Panel is © its author, MIT-licensed; its licence and third-party
notices are in `tiiny_panel/panel/`.
