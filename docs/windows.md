# map-pane on Windows

Windows runs the **browser map**: the bridge, the CLI (`map-command`) and the skill all work, and the map opens in your default browser.
There is no Ghostty split. The terminal pane (Kitty graphics) is untested on Windows.

## Requirements

| Item | Requirement |
|---|---|
| Windows | 10 or 11 |
| Node.js | 24.2 or later (`node --version`). No npm packages. |
| Browser | Any browser for `--browser`. Chrome or Edge only for the terminal pane. |
| Network | Access to `js.arcgis.com` and the basemap tile servers |

## Start the map

From the repository folder, in PowerShell or cmd:

```powershell
mappane\bin\map-pane.cmd --browser          # or: node mappane\cli\launch.mjs --browser  /  npm run browser
mappane\bin\map-command.cmd go_to location "Paris, France"
mappane\bin\map-command.cmd graphics examples\cities.geojson --title Cities --renderer examples\population-renderer.json
mappane\bin\map-command.cmd zoom
mappane\bin\map-pane.cmd --close            # stops the bridge; the browser tab stays open
```

In Git Bash the extensionless scripts work too: `mappane/bin/map-pane --browser`.
Use the `.cmd` name in PowerShell: it can mistake the extensionless bash script for a document.

## How it differs from macOS

| Subject | macOS and Linux | Windows |
|---|---|---|
| Command channel | Unix socket, mode 0600 | Named pipe with a random name. Only you, administrators and SYSTEM can write to it |
| Finding the bridge | Newest `command-<pid>.sock` in `<tmpdir>/map-pane-<uid>/` | Newest `command-<pid>.pipe` in `%TEMP%\map-pane-<user>\`, which names the pipe |
| `--close` | Kills the bridge, closes Chrome tabs | Asks the bridge to stop (`POST /shutdown` on its pipe); the tab stays open |
| Private-file checks | Owner and mode 600 | Not applied: Windows has no mode bits, and `%TEMP%` and `%USERPROFILE%` belong to you |
| `login` | Opens the browser on macOS | Opens the browser through `rundll32` |
| Chrome path | `/Applications/...` | `CHROME`, else Program Files, Program Files (x86) and Local AppData, then Edge |
| `--split` | Ghostty | Not available |

## Claude Code skill

Install it as on macOS (`/plugin install map-pane --marketplace mraad/map-pane`).
Claude Code on Windows runs the bash scripts through Git Bash; if it uses PowerShell, the skill tells it to call the `.cmd` twins.
Heredocs are bash only: in PowerShell, pass JSON and code from a file or on standard input.

## Verified

Checked on 2026-11-23 with Node 24.22.3 and Chrome on Windows 11 ARM64 (a Parallels VM) and on a Windows x64 machine (also with Node 25.1), both build 26200:

- `launch`, `lib`, `commands`, `server-url` and `manifests` suites.
- The `.cmd` wrappers in cmd, and the bash scripts in Git Bash.
- A map in Chrome (x64: headless Chrome, so the default browser was not opened there): `--browser`, `go_to`, `graphics`, `zoom`, `js` (also from PowerShell standard input), `screenshot`, `--close`.
- The Node library (`run`, `connect`), and a bridge killed by force.
- The access list of the pipe: Everyone can read, and only the user, administrators and SYSTEM can write. A bridge that an elevated shell starts lists administrators and SYSTEM only.
- A fresh Git checkout (x64).

Not checked on Windows: `login`, the terminal pane, Edge and the plugin install.
`.github/workflows/windows.yml` runs the same suites and wrappers on a `windows-latest` runner. The older suites (`cli`, `server`, `e2e`, `pane`, `browser`) drive bash scripts and Unix sockets and are not run there.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `'node' is not recognized` | Node is not on `PATH` | Install Node 24.2 or later and open a new terminal. |
| `No running map found` | No bridge, or a stale `.pipe` file | Run `map-pane.cmd --browser`. The CLI deletes stale registry files itself. |
| `could not open a browser; open <url> yourself` | `rundll32` could not start the default browser | Open the printed URL. |
| `cannot start Chrome at …` (pane only) | Chrome is not in Program Files | Set `CHROME` to `chrome.exe` or `msedge.exe`. |
| PowerShell asks which app opens `map-pane` | It found the bash script | Type `map-pane.cmd`. |
