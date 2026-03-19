# JDE AIS Bridge — Python Backend

FastAPI server that wraps `jde_ais_connector.py` and exposes AIS calls to the React frontend.

## Setup

```bash
cd server
pip install -r requirements.txt
cp ../.env.example .env
# Edit .env with your JDE credentials
```

## Run

```bash
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/test-connection` | Validate AIS credentials |
| POST | `/api/run-orchestration` | Execute a named orchestration |
| POST | `/api/fetch-data` | Query a JDE table / business view |
| POST | `/api/fetch-form` | Fetch JDE form data |
| POST | `/api/submit-form` | Submit a JDE form action |

Interactive docs: `http://localhost:8000/docs`

## Environment Variables

Copy `.env.example` to `.env` in the project root or `/server`:

```
AIS_BASE_URL=https://your-jde-server/jderest
AIS_USERNAME=JDEUSER
AIS_PASSWORD=your_password_here
AIS_TIMEOUT=30
```

Credentials can also be passed per-request from the React frontend (they are never stored server-side).
