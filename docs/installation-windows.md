# Installation — Windows 10

> **Verification status: Windows steps not yet verified on a Windows machine.**
> Every step below is either (a) verified on the Linux dev VM
> (Ubuntu 24.04, Node 24.22.1, Python 3.12.3, FFmpeg 8.1.2) and marked
> **Linux-verified**, or (b) a Windows-specific step that has **not** been run
> on Windows and is marked **Windows — not yet verified**. Do not treat a
> Windows step as confirmed until someone runs it on a real Windows 10 PC
> (target: Intel i7, 8 GB RAM, CPU-only) and records the result.

Target machine: **Windows 10, Intel Core i7, 8 GB RAM, GPU unknown — assume
CPU-only.** Zero-budget: every dependency below is free/open-source.

## 1. Install prerequisites

### Node.js 22+ — Windows — not yet verified

1. Download the **LTS** installer from https://nodejs.org/en/download
   (Windows Installer `.msi`, 64-bit).
2. Run it, accept the defaults (this adds Node and npm to PATH).
3. Verify in a **new** PowerShell window:

```powershell
node --version   # expect v22.x or newer
npm --version
```

Linux-verified equivalent on this VM: `node --version` → `v24.22.1`.

### Python 3.12 — Windows — not yet verified

1. Download the Windows installer from https://www.python.org/downloads/
   (Python 3.12.x, 64-bit).
2. **Tick "Add python.exe to PATH"** on the first screen, then Install.
3. Verify:

```powershell
python --version   # expect Python 3.12.x
pip --version
```

Linux-verified equivalent: `python3 --version` → `Python 3.12.3`.

### FFmpeg + FFprobe — Windows — not yet verified

1. Download a static build from https://www.gyan.dev/ffmpeg/builds/
   (`ffmpeg-release-full.7z`).
2. Extract to `C:\ffmpeg` so that `C:\ffmpeg\bin\ffmpeg.exe` exists.
3. Add `C:\ffmpeg\bin` to the system PATH:
   Settings → System → About → Advanced system settings → Environment
   Variables → Path → New → `C:\ffmpeg\bin` → OK.
4. Verify in a **new** PowerShell window:

```powershell
ffmpeg -version
ffprobe -version
```

Linux-verified equivalent: `ffmpeg -version` → `ffmpeg version 8.1.2`;
`ffprobe -version` → `ffprobe version 8.1.2`.

### PHP 8.2+ and Composer — Windows — not yet verified

> **Blocker note:** PHP and Composer are **not installed on the Linux dev VM**
> either (`php: command not found`, 2026-11-22). The Laravel backend cannot
> start until PHP + Composer exist on the machine that runs it. This is a
> known Phase 1 gap — see the root README.

1. Download the PHP 8.2+ **Thread Safe** x64 ZIP from
   https://windows.php.net/download/ and extract to `C:\php`.
2. Copy `C:\php\php.ini-development` to `C:\php\php.ini` and enable the
   extensions Laravel needs (at minimum: `fileinfo`, `mbstring`, `openssl`,
   `pdo_sqlite`, `sqlite3`, `zip`, `curl`).
3. Add `C:\php` to PATH as above.
4. Download the Composer installer from https://getcomposer.org/Composer-Setup.exe
   and run it (it finds `C:\php\php.exe` automatically).
5. Verify:

```powershell
php --version      # expect PHP 8.2.x or newer
composer --version # expect Composer version 2.x
```

## 2. Clone the project — Windows — not yet verified

```powershell
git clone <repo-url> magician-clipper
cd magician-clipper
```

(If Git is not installed, install it from https://git-scm.com/download/win first.)

## 3. Environment

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in at least `APP_KEY` (Laravel generates it — see step 4) and check the
URLs/paths in [environment.md](environment.md). Never commit a real `.env`.

## 4. Install per service

### Video engine (Python/FastAPI) — Linux-verified commands

```powershell
cd services\video-engine
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

(Linux equivalent verified: `python3 -m venv` + `pip install` pattern is
standard; the engine's own `requirements.txt` is owned by the video-engine
builder — **Pending**.)

### Backend (Laravel) — Windows — not yet verified (blocked on PHP)

```powershell
cd backend\laravel
composer install
php artisan key:generate
php artisan migrate --seed
```

### Frontend (React/Vite) — Linux-verified commands

```powershell
cd apps\web
npm install
```

## 5. Run

Open **three** separate PowerShell windows (or use `scripts\dev.ps1` once it
exists — **Pending**):

```powershell
# Window 1 — video engine (port 8001)
cd services\video-engine
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8001

# Window 2 — backend (port 8000)
cd backend\laravel
php artisan serve --host=127.0.0.1 --port=8000

# Window 3 — frontend (port 5173)
cd apps\web
npm run dev
```

Then open http://localhost:5173 and check health:

```powershell
curl.exe http://127.0.0.1:8001/health
curl.exe http://127.0.0.1:8000/api/v1/health
```

On Linux the equivalent check is `bash scripts/health-check.sh`
(syntax-checked; live run pending services).

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `ffmpeg` not recognized | `C:\ffmpeg\bin` not on PATH, or the PowerShell window was opened before the PATH change — open a new window |
| `python` not recognized | "Add to PATH" was not ticked — reinstall Python with the box ticked, or add `C:\Users\<you>\AppData\Local\Programs\Python\Python312\` to PATH |
| `php` not recognized | `C:\php` not on PATH, or `php.ini` missing required extensions |
| `composer install` fails on `ext-*` | Enable the named extension in `C:\php\php.ini` and retry |
| Port 8000/8001/5173 already in use | Another service is running — stop it, or change the port in `.env` and the run command |
| Uploads fail / "file too large" | Check `MAX_UPLOAD_MB` in `.env` and PHP `upload_max_filesize` / `post_max_size` in `php.ini` |
| Transcription is slow / OOM | Use `WHISPER_MODEL=tiny` and `WHISPER_CPU_THREADS=4` (defaults); 8 GB RAM target — do not use large models |
| Job stuck in `queued` | Queue worker not running — start it (`php artisan queue:work`) and check `GET /api/v1/admin/system/health` |

## 7. What is NOT verified yet

- [ ] Every step above run end-to-end on a real Windows 10 machine
- [ ] PHP + Composer install on Windows
- [ ] `php artisan migrate` on Windows (SQLite)
- [ ] All three services running together on Windows
- [ ] An actual upload → real clip on Windows
- [ ] Windows desktop installer (Tauri) — Phase 5 milestone, not Phase 1
