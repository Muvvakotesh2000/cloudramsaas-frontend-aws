# CloudRAMSaaS Frontend

Flask web frontend for the CloudRAMSaaS cloud desktop platform. Provides login/register UI, a real-time dashboard for managing cloud desktop sessions, and integration with the local agent for VSCode/file migration.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│                                                                   │
│  ┌────────────────┐    ┌────────────────────────────────────┐   │
│  │  Supabase JS   │    │  Dashboard                          │   │
│  │  (Auth SDK)    │    │  - Agent detection (localhost:7071) │   │
│  │  - Sign in     │    │  - Session allocate/stop/connect    │   │
│  │  - Sign up     │    │  - VSCode migration                 │   │
│  │  - JWT tokens  │    │  - Task list (local processes)      │   │
│  └────────────────┘    │  - Heartbeat (30s keep-alive)       │   │
│                         │  - Activity log                     │   │
│                         └────────────────────────────────────┘   │
└──────────┬────────────────────────────┬──────────────────────────┘
           │                            │
           ▼ REST API                   ▼ localhost:7071
   ┌───────────────┐           ┌────────────────────┐
   │  Backend API  │           │  Local Agent       │
   │  (FastAPI)    │           │  (on user machine) │
   └───────────────┘           └────────────────────┘
```

## Tech Stack

- **Framework:** Flask 3.0.3
- **Server:** Gunicorn (production), Flask dev server (local)
- **Templating:** Jinja2
- **Auth:** Supabase JS SDK v2 (client-side)
- **Styling:** Custom CSS (dark theme, CSS variables)
- **JavaScript:** Vanilla JS (no framework)
- **Python:** 3.11

## Pages

| Route | Template | Description |
|-------|----------|-------------|
| `/` | `index.html` | Login / Register (Supabase email auth) |
| `/dashboard` | `status.html` | Main dashboard (session management) |
| `/health` | — | Health check endpoint (JSON) |

## Project Structure

```
├── app.py                 # Flask app, routes, config
├── requirements.txt       # Python dependencies
├── static/
│   ├── script.js          # Dashboard logic (512 lines)
│   │                      #   - Agent detection & polling
│   │                      #   - Session lifecycle (allocate/stop/heartbeat)
│   │                      #   - VSCode migration trigger
│   │                      #   - Save project to local
│   │                      #   - UI state management
│   └── style.css          # Dark-themed responsive UI (616 lines)
│                          #   - Auth page styles
│                          #   - Dashboard layout
│                          #   - Agent status card
│                          #   - Session card with status badges
│                          #   - Activity log
├── templates/
│   ├── index.html         # Auth page (login/register tabs)
│   └── status.html        # Dashboard (agent, session, tasks, log)
└── .env                   # Environment variables (not committed)
```

## Features

### Authentication
- Email/password sign-up and sign-in via Supabase JS SDK
- Automatic redirect to dashboard if already authenticated
- Session refresh before every API call (prevents stale tokens)

### Agent Detection
- Polls `http://127.0.0.1:7071/health` every 5s (slows to 10s once connected)
- Shows online/offline status with platform badge (Windows/macOS)
- Download links for agent installer (Windows .exe, macOS .dmg)
- "Allocate Desktop" button disabled until agent is detected

### Session Management
- **Allocate:** Launches a cloud desktop via backend API
- **Status polling:** Every 5s during provisioning
- **Connect:** Opens noVNC URL in new tab when session is RUNNING
- **Heartbeat:** Every 30s to keep session alive
- **Stop:** Terminates ECS task (workspace files preserved on EFS)

### Local Tasks & Migration
- Fetches running tasks from local agent (Code.exe, notepad++.exe, chrome.exe)
- **Migrate VSCode:** Zips project + config → uploads to S3 → VM extracts to EFS
- **Save to Local:** Downloads project from cloud EFS → S3 → local filesystem

### Activity Log
- Real-time event log (max 50 entries)
- Color-coded by type (info/success/error/warning)
- Timestamps for each event

## Environment Variables

```env
# Supabase (passed to templates for client-side SDK)
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon-key>

# Backend
BACKEND_BASE_URL=https://cloudramsaas-backend-aws.onrender.com

# Flask
FLASK_SECRET_KEY=<random-secret-string>
PORT=5000
```

## Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Set environment variables
cp ../.env.example .env
# Fill in SUPABASE_URL, SUPABASE_ANON_KEY, BACKEND_BASE_URL, FLASK_SECRET_KEY

# Run
python app.py
# Server starts at http://localhost:5000
```

## Deployment (Render)

This service is deployed on Render at `https://cloudramsaas-frontend-aws.onrender.com`.

**Build command:** `pip install -r requirements.txt`  
**Start command:** `gunicorn app:app --bind 0.0.0.0:$PORT`

## UI Design

- **Dark theme** with indigo/purple brand accent (`#6366f1`)
- CSS custom properties for consistent theming
- Responsive design (mobile breakpoint at 600px)
- Status badges with animated dots (pulse for running/provisioning)
- Loading spinners for async operations
- Monospace font for technical values (IPs, ports, session IDs)

## Security

- Session cookies: `HttpOnly=True`, `SameSite=Lax`
- Auth handled entirely client-side by Supabase SDK (no server-side token storage)
- CORS managed by backend; frontend makes cross-origin requests with Bearer token
- Agent communication restricted to localhost (127.0.0.1:7071)
- No sensitive data in templates (keys injected via Jinja2 at render time)
