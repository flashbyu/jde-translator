"""
Oracle JD Edwards AIS Server API Connector
Supports Basic Auth, GET (fetch) and POST (submit) operations.
Uses: requests, python-dotenv
"""

import os
import requests
from requests.auth import HTTPBasicAuth
from dotenv import load_dotenv

load_dotenv()


class JDEAISConnector:
    """
    Connector for Oracle JD Edwards AIS (Application Interface Services) Server.

    Environment variables (set in .env file):
        AIS_BASE_URL   - Base URL of the AIS server, e.g. https://your-jde-server/jderest
        AIS_USERNAME   - JDE username
        AIS_PASSWORD   - JDE password
        AIS_TIMEOUT    - Request timeout in seconds (default: 30)
    """

    def __init__(
        self,
        base_url: str = None,
        username: str = None,
        password: str = None,
        timeout: int = None,
        verify_ssl: bool = True,
    ):
        self.base_url = (base_url or os.getenv("AIS_BASE_URL", "")).rstrip("/")
        self.username = username or os.getenv("AIS_USERNAME")
        self.password = password or os.getenv("AIS_PASSWORD")
        self.timeout = timeout or int(os.getenv("AIS_TIMEOUT", 30))
        self.verify_ssl = verify_ssl
        self.token = None  # populated after tokenrequest login

        if not self.base_url:
            raise ValueError("AIS_BASE_URL is required (env var or constructor arg).")
        if not self.username or not self.password:
            raise ValueError("AIS_USERNAME and AIS_PASSWORD are required.")

        self.session = requests.Session()
        self.session.auth = HTTPBasicAuth(self.username, self.password)
        self.session.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def login(self) -> dict:
        """
        Authenticate against AIS /tokenrequest endpoint.
        Stores the returned token for subsequent calls.
        Returns the full response payload.
        """
        url = f"{self.base_url}/tokenrequest"
        payload = {
            "username": self.username,
            "password": self.password,
            "deviceName": "PythonAISConnector",
            "requiredCapabilities": "grid,processingOption",
        }
        response = self._post(url, payload, use_token=False)
        self.token = response.get("userInfo", {}).get("token")
        if self.token:
            self.session.headers.update({"jde-AIS-Auth": self.token})
        return response

    def logout(self) -> dict:
        """Invalidate the current AIS session token."""
        url = f"{self.base_url}/tokenrequest/logout"
        result = self._post(url, {})
        self.token = None
        self.session.headers.pop("jde-AIS-Auth", None)
        return result

    # ------------------------------------------------------------------
    # Core HTTP helpers
    # ------------------------------------------------------------------

    def _get(self, url: str, params: dict = None) -> dict:
        """Internal GET request with error handling."""
        try:
            response = self.session.get(
                url,
                params=params,
                timeout=self.timeout,
                verify=self.verify_ssl,
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            self._handle_http_error(e)
        except requests.exceptions.ConnectionError:
            raise ConnectionError(f"Unable to reach AIS server at {self.base_url}. Check AIS_BASE_URL.")
        except requests.exceptions.Timeout:
            raise TimeoutError(f"Request timed out after {self.timeout}s.")

    def _post(self, url: str, payload: dict, use_token: bool = True) -> dict:
        """Internal POST request with error handling."""
        headers = {}
        if not use_token:
            headers["jde-AIS-Auth"] = ""  # suppress token header for login call
        try:
            response = self.session.post(
                url,
                json=payload,
                timeout=self.timeout,
                verify=self.verify_ssl,
                headers=headers if headers else None,
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            self._handle_http_error(e)
        except requests.exceptions.ConnectionError:
            raise ConnectionError(f"Unable to reach AIS server at {self.base_url}. Check AIS_BASE_URL.")
        except requests.exceptions.Timeout:
            raise TimeoutError(f"Request timed out after {self.timeout}s.")

    @staticmethod
    def _handle_http_error(error: requests.exceptions.HTTPError):
        status = error.response.status_code if error.response is not None else "unknown"
        try:
            detail = error.response.json()
        except Exception:
            detail = error.response.text if error.response is not None else str(error)
        raise RuntimeError(f"AIS HTTP {status} error: {detail}") from error

    # ------------------------------------------------------------------
    # Form Requests (Orchestrator / Business Function calls)
    # ------------------------------------------------------------------

    def fetch_form(self, form_request: dict) -> dict:
        """
        POST to the AIS /formrequest endpoint to fetch JDE form data.

        Args:
            form_request: AIS FormRequest payload dict. Example:
                {
                    "formName": "P4101_W4101B",
                    "version": "ZJDE0001",
                    "maxPageSize": "100",
                    "returnControlIDs": "1|2|3",
                    "query": {...}          # optional filter
                }

        Returns:
            Parsed JSON response from AIS.
        """
        url = f"{self.base_url}/formrequest"
        return self._post(url, form_request)

    def submit_form(self, form_name: str, version: str, actions: list) -> dict:
        """
        POST to the AIS /formrequest endpoint to submit data / trigger actions.

        Args:
            form_name:  JDE application + form ID, e.g. "P4210_W4210A"
            version:    Application version, e.g. "ZJDE0001"
            actions:    List of AIS action dicts (SetControlValue, DoAction, etc.)

        Returns:
            Parsed JSON response from AIS.
        """
        payload = {
            "formName": form_name,
            "version": version,
            "formActions": actions,
        }
        url = f"{self.base_url}/formrequest"
        return self._post(url, payload)

    # ------------------------------------------------------------------
    # Orchestrator
    # ------------------------------------------------------------------

    def run_orchestration(self, orchestration_name: str, inputs: dict = None) -> dict:
        """
        Execute a JDE Orchestration via AIS.

        Args:
            orchestration_name: Name of the orchestration defined in Orchestrator Studio.
            inputs:             Input values dict for the orchestration.

        Returns:
            Parsed JSON response.
        """
        url = f"{self.base_url}/orchestrator/{orchestration_name}"
        return self._post(url, inputs or {})

    # ------------------------------------------------------------------
    # Data Request (lightweight data fetch)
    # ------------------------------------------------------------------

    def fetch_data(self, data_request: dict) -> dict:
        """
        POST to the AIS /datarequest endpoint for lightweight data retrieval.

        Args:
            data_request: AIS DataRequest payload. Example:
                {
                    "targetName": "F4101",
                    "targetType": "table",
                    "dataItems": ["ITM","DSC1","LITM"],
                    "query": {
                        "condition": [...],
                        "matchType": "MATCH_ALL"
                    },
                    "maxPageSize": "50"
                }

        Returns:
            Parsed JSON response.
        """
        url = f"{self.base_url}/datarequest"
        return self._post(url, data_request)

    # ------------------------------------------------------------------
    # Convenience: context manager support
    # ------------------------------------------------------------------

    def __enter__(self):
        self.login()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            self.logout()
        except Exception:
            pass
        return False


# ----------------------------------------------------------------------
# Example usage
# ----------------------------------------------------------------------

if __name__ == "__main__":
    # Option 1: Explicit credentials
    # connector = JDEAISConnector(
    #     base_url="https://your-jde-server/jderest",
    #     username="JDEUSER",
    #     password="secret",
    # )

    # Option 2: Load from .env file (recommended)
    # Create a .env file with:
    #   AIS_BASE_URL=https://your-jde-server/jderest
    #   AIS_USERNAME=JDEUSER
    #   AIS_PASSWORD=secret

    # Option 3: Use as a context manager (auto login/logout)
    with JDEAISConnector() as ais:
        # --- Fetch example: retrieve items from Item Master (F4101) ---
        result = ais.fetch_data({
            "targetName": "F4101",
            "targetType": "table",
            "dataItems": ["ITM", "DSC1", "LITM", "STKT"],
            "maxPageSize": "10",
        })
        print("Fetch result:", result)

        # --- Post example: run an orchestration ---
        orch_result = ais.run_orchestration(
            "MY_ORCHESTRATION_NAME",
            inputs={"BusinessUnit": "100", "ItemNumber": "1001"},
        )
        print("Orchestration result:", orch_result)
