# Desktop process boundaries

## Local media and system opening

`electron-main/media-access.cjs` validates absolute paths, resolves symlinks and checks file types. The `local-res` protocol serves media only. It cannot serve configuration, executables, scripts, SSH credentials, or arbitrary files from the application profile. The profile exceptions are the `captured`, `asset-library` and `reference-cache` media directories.

Native file/folder selection and trusted OS drop events grant access in the main process. Grants are stored separately in `data/media-access.v1.json`. On the first upgrade only, supported existing board files and linked folders seed this registry. After that, changing a path in `board.json` does not create a new grant. Programmatic imports outside existing authorized directories must be authorized by native selection before previewing them.

`local-res` no longer bypasses CSP or returns wildcard CORS headers. It accepts application origins, rejects document/iframe embedding, sends `nosniff` and restrictive CSP, and keeps HEAD/range support for video. Streams verify the opened file against the authorized file identity. Main-frame shell IPC checks both the authorized path and a non-executable extension list. `.blend` and `.gh` files may be managed as assets but are not launched by the generic shell opener; application integrations have their own launch routes.

## Windows and credentials

The main and floating windows use `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. Unrequested new windows and webview attachment are denied. Rhino/Blender launchers and MCP configuration retain their own interfaces.

`ApiConfigStore` refuses new writes when platform encryption is unavailable. It preserves the existing primary file, can read legacy plaintext for migration, and encrypts new saves and backups. It does not retroactively erase old backup files or disk remnants.

The desktop renderer no longer writes new API configuration into localStorage. Existing legacy cache entries are removed only after an encrypted save succeeds. Failed saves show a visible error and retain the legacy recovery source. The standalone browser development UI, without the Electron bridge, still uses its existing localStorage behavior.

## External webpage downloads

`public-media-download.cjs` applies only to untrusted external webpage images, not configured model APIs or local MCP services. It validates public HTTP(S) destinations and every redirect, rejects private/reserved addresses, pins DNS results to the connection, and limits response size and total duration.

When TUN DNS returns only `198.18.0.0/15` fake addresses for a hostname, the downloader obtains a public IPv4 answer through Cloudflare DNS-over-HTTPS at `1.1.1.1`, validates it, and connects to that address. Literal fake/private IP URLs remain blocked. This downloader uses Node HTTP(S) and the system proxy route reported by Electron. HTTP(S) and SOCKS tunnels target the validated IP while retaining the original Host header and TLS hostname verification. It does not forward Chromium cookies or proxy authentication credentials. TUN networking was verified on Windows.

## Verification and scope

- `npm run check`: lint, unit tests and renderer build.
- `scripts/security-boundary-smoke.cjs`: isolated Electron profile; sandbox/preload, image/video/seek/export, denied credential reads and executable opens, allowed shell dispatch, private download rejection. OS file opening is stubbed; no executable fixture is run.
- `scripts/agent-materials-smoke.cjs`: Agent material selection, copying and persistence.
- `scripts/media-preview-smoke.cjs`: preview resolution, restart and unchanged source files.

These changes address the reviewed media protocol, generic shell opening, window sandbox, credential fallback and external image downloader. They are not a complete authorization review of all existing IPC/MCP tools. The renderer still holds configured API keys in memory for compatibility; a compromised application renderer is not equivalent to an untrusted external webpage. macOS requires a separate real-machine check.
