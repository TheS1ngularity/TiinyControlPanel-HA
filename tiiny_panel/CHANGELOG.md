# Changelog

## 1.4.1-ha7
- New option "Tiiny address": set the device's address from the Configuration tab instead of in the panel.
- Fix: with automatic unlock on and a password filled in, the add-on now also logs in when no key is saved yet (a new install), not only when the Tiiny is locked.

## 1.4.1-ha6
- New: **Auto-load** button in the panel's top bar. Tick models there and they are loaded automatically after the Tiiny is unlocked again.
- New option "Tiiny password" (empty by default): fallback for automatic unlock when the Tiiny refuses the saved key.
- Automatic unlock now writes the Tiiny's answer to the log when it refuses, and keeps watching after it gives up, so a log in by hand is noticed.

## 1.4.1-ha5
- New option "Unlock the Tiiny automatically" (off by default): unlocks the device after a restart or power cut with the key saved at your last log in.

## 1.4.1-ha4
- Fix: apps on other machines were refused by the gateway on port 8766 ("Forbidden host"). New option "Gateway: accept any numeric address", on by default.

## 1.4.1-ha3
- Fix: nothing typed in the panel was saved inside Home Assistant (settings, log in, chat). Home Assistant sends request bodies in chunks, which the panel didn't read.

## 1.4.1-ha2
- Options on the Configuration tab: trust the Home Assistant login, let the agent run commands, extra host names, request logging.

## 1.4.1-ha1
- First build: Tiiny Control Panel 1.4.1 inside Home Assistant (Ingress).
