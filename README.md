# CloudRAMSaaS Frontend

Flask web frontend for CloudRAMSaaS — a cloud desktop platform that lets users provision on-demand GUI environments. Provides authentication (email + Google OAuth), a real-time dashboard for managing cloud sessions, project file transfer, and IDE settings persistence.

## Architecture

```
+----------------------------------------------------------+
|  Browser                                                  |
|                                                           |
|  Supabase JS SDK          Dashboard (script.js)           |
|  - Email sign in/up       - Session allocate/stop         |
|  - Google OAuth            - noVNC connect                 |
|  - JWT management         - File upload (zip + S3)        |
|                            - Project download              |
|                            - IDE config save               |
|                            - Heartbeat (30s keep-alive)   |
|                            - Activity log                  |
+-------------+--------------------------------------------+
              |
              v  REST API (Bearer JWT)
       +---------------+
       |  Backend API   |
       |  (FastAPI)     |
       +---------------+
```

## Tech Stack

- **Framework:** Flask 3.0.3
- **Server:** Gunicorn (production), Flask dev server (local)
- **Templating:** Jinja2
- **Auth:** Supabase JS SDK v2 (email/password + Google OAuth)
- **Styling:** Custom CSS (dark theme, CSS variables)
- **JavaScript:** Vanilla JS, JSZip for client-side zipping
- **Python:** 3.11

## Pages

| Route | Template | Description |
|-------|----------|-------------|
| `/` | `index.html` | Login / Register with email or Google |
| `/dashboard` | `status.html` | Session management, file transfer, IDE settings |
| `/health` | -- | Health check (JSON) |

## Project Structure

```
├── app.py                 # Flask app, routes, Supabase config injection
├── requirements.txt
├── static/
│   ├── script.js          # Dashboard logic
│   │                      #   - Session lifecycle (allocate/stop/heartbeat)
│   │                      #   - File upload with progress (zip -> S3 -> VM)
│   │                      #   - Project list and download
│   │                      #   - IDE settings save/restore
│   │                      #   - Desktop notifications
│   └── style.css          # Dark-themed responsive UI
│                          #   - Auth page (Google button, divider, tabs)
│                          #   - Dashboard cards, dropzone, progress bars
│                          #   - Status indicators with animations
├── templates/
│   ├── index.html         # Auth page (Google OAuth + email/password tabs)
│   └── status.html        # Dashboard (session, transfer, projects, IDE, log)
└── .env                   # Environment variables (not committed)
```

## Features

### Authentication
- **Google OAuth** via Supabase — one-click sign in with Google
- **Email/password** sign up and sign in
- Automatic redirect to dashboard if already authenticated
- Token refresh before API calls to prevent stale sessions

### Session Management
- **Allocate:** Provisions a cloud desktop via the backend API
- **Status polling:** Every 5s during provisioning, auto-stops when running
- **Connect:** Opens noVNC URL in a new tab when session is RUNNING
- **Heartbeat:** Every 30s to keep the session alive
- **Stop:** Terminates the cloud desktop (files preserved)
- **Desktop notifications** when codespace becomes ready

### File Transfer
- **Upload:** Drag-and-drop or file/folder picker -> client-side zip -> S3 -> VM
- **Download:** Export project from cloud desktop -> S3 presigned URL -> browser download
- Upload progress bar with percentage
- Supports multiple IDEs: VS Code, Sublime Text, Eclipse, IntelliJ IDEA, PyCharm

### IDE Settings Persistence
- Save individual or all IDE configurations to S3
- Settings persist across sessions (themes, keybindings, extensions, plugins)

### Activity Log
- Real-time event log (max 50 entries)
- Color-coded by type: info, success, error, warning
- Collapsible panel

## Environment Variables

```env
# Supabase (injected into templates for client-side SDK)
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon-key>

# Backend API
BACKEND_BASE_URL=https://cloudramsaas-backend-aws.onrender.com

# Flask
FLASK_SECRET_KEY=<random-secret-string>
PORT=5000
```

## Local Development

```bash
pip install -r requirements.txt
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_ANON_KEY, BACKEND_BASE_URL, FLASK_SECRET_KEY

python app.py
# Server starts at http://localhost:5000
```

## Deployment (Render)

Deployed at `https://cloudramsaas-frontend-aws.onrender.com`

**Build command:** `pip install -r requirements.txt`
**Start command:** `gunicorn app:app --bind 0.0.0.0:$PORT`

### Required Render Environment Variables

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `BACKEND_BASE_URL` | Render backend URL |
| `FLASK_SECRET_KEY` | Random secret string |

## Google OAuth Setup

To enable "Continue with Google":

1. **Google Cloud Console:** Create OAuth 2.0 credentials (Web application)
2. **Authorized redirect URI:** `https://<supabase-ref>.supabase.co/auth/v1/callback`
3. **Supabase Dashboard:** Authentication > Providers > Google — paste Client ID and Secret

## Security

- Session cookies: `HttpOnly=True`, `SameSite=Lax`
- Auth handled client-side by Supabase SDK (no server-side token storage)
- Supabase keys injected via Jinja2 at render time (not hardcoded in JS)
- CORS managed by the backend service
