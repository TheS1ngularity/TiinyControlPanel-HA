# Third-party notices

Tiiny Control Panel is released under the [MIT License](LICENSE). It includes the following
libraries in `static/vendor/`, unchanged, so that the panel works without an internet connection.

| Library | Version | Used for | License | Files |
|---|---|---|---|---|
| [xterm.js](https://github.com/xtermjs/xterm.js) and its fit addon | 5.5.0 | The terminal inside the page | MIT | `static/vendor/xterm/` ([LICENSE](static/vendor/xterm/LICENSE)) |
| [model-viewer](https://github.com/google/model-viewer) by Google | 4.4.0 | Showing 3D models in the Studio and Gallery | Apache-2.0 | `static/vendor/model-viewer/` ([LICENSE](static/vendor/model-viewer/LICENSE)) |
| ↳ [Lit](https://github.com/lit/lit), bundled inside model-viewer | | | BSD-3-Clause | license headers kept in `model-viewer.min.js` |
| ↳ [three.js](https://github.com/mrdoob/three.js), bundled inside model-viewer | | | MIT | license headers kept in `model-viewer.min.js` |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase | 2.0.4 | The QR code for pairing a phone | MIT | `static/vendor/qrcode/` ([LICENSE](static/vendor/qrcode/LICENSE)) |

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

"Tiiny" and TiinyOS are names of their respective owner. This project is an independent community
project and is not affiliated with or endorsed by Tiiny.
