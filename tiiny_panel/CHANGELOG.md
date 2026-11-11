# Changelog

## 1.4.1-ha4
- Fix: apps on other machines were refused by the gateway on port 8766 ("Forbidden host"). New option "Gateway: accept any numeric address", on by default.

## 1.4.1-ha3
- Fix: nothing typed in the panel was saved inside Home Assistant (settings, log in, chat). Home Assistant sends request bodies in chunks, which the panel didn't read.

## 1.4.1-ha2
- Options on the Configuration tab: trust the Home Assistant login, let the agent run commands, extra host names, request logging.

## 1.4.1-ha1
- First build: Tiiny Control Panel 1.4.1 inside Home Assistant (Ingress).
