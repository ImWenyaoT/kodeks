from fastapi.testclient import TestClient

from kodeks.app import create_app


def test_root_serves_built_index():
    """The root path serves the built Next static export index shell."""

    client = TestClient(create_app())
    res = client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]


def test_api_routes_not_shadowed_by_static_mount():
    """API routes registered before the static mount keep taking precedence."""

    client = TestClient(create_app())
    assert client.get("/health").json()["ok"] is True
    assert client.get("/api/models").status_code == 200
