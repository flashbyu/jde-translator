"""
JDE Translator — FastAPI Backend
Wraps jde_ais_connector.py to expose AIS calls to the React frontend.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any, Optional
import os

from jde_ais_connector import JDEAISConnector

app = FastAPI(title="JDE AIS Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class AISCredentials(BaseModel):
    base_url: str
    username: str
    password: str
    timeout: Optional[int] = 30
    verify_ssl: Optional[bool] = True

class TestConnectionRequest(BaseModel):
    credentials: AISCredentials

class RunOrchestrationRequest(BaseModel):
    credentials: AISCredentials
    orchestration_name: str
    inputs: Optional[dict] = {}

class FetchDataRequest(BaseModel):
    credentials: AISCredentials
    target_name: str
    target_type: Optional[str] = "table"
    data_items: list[str]
    query: Optional[dict] = None
    max_page_size: Optional[str] = "50"

class FormFetchRequest(BaseModel):
    credentials: AISCredentials
    form_request: dict

class FormSubmitRequest(BaseModel):
    credentials: AISCredentials
    form_name: str
    version: str
    actions: list[dict]

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def make_connector(creds: AISCredentials) -> JDEAISConnector:
    return JDEAISConnector(
        base_url=creds.base_url,
        username=creds.username,
        password=creds.password,
        timeout=creds.timeout,
        verify_ssl=creds.verify_ssl,
    )

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/test-connection")
def test_connection(body: TestConnectionRequest):
    """Attempt login and immediately logout to validate credentials."""
    try:
        connector = make_connector(body.credentials)
        result = connector.login()
        connector.logout()
        user_info = result.get("userInfo", {})
        return {
            "success": True,
            "message": f"Connected as {user_info.get('userID', body.credentials.username)}",
            "environment": user_info.get("environment", ""),
            "role": user_info.get("role", ""),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/run-orchestration")
def run_orchestration(body: RunOrchestrationRequest):
    """Execute a named orchestration with the given inputs."""
    try:
        with make_connector(body.credentials) as ais:
            result = ais.run_orchestration(body.orchestration_name, body.inputs)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/fetch-data")
def fetch_data(body: FetchDataRequest):
    """Fetch records from a JDE table or business view."""
    payload = {
        "targetName": body.target_name,
        "targetType": body.target_type,
        "dataItems": body.data_items,
        "maxPageSize": body.max_page_size,
    }
    if body.query:
        payload["query"] = body.query
    try:
        with make_connector(body.credentials) as ais:
            result = ais.fetch_data(payload)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/fetch-form")
def fetch_form(body: FormFetchRequest):
    """Fetch JDE form data."""
    try:
        with make_connector(body.credentials) as ais:
            result = ais.fetch_form(body.form_request)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/submit-form")
def submit_form(body: FormSubmitRequest):
    """Submit a JDE form action."""
    try:
        with make_connector(body.credentials) as ais:
            result = ais.submit_form(body.form_name, body.version, body.actions)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
