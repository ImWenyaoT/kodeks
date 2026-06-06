from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import kodeks
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


def test_next_assets_are_served():
    """Hashed `_next/` bundle assets serve with 200 (guards the StaticFiles mount).

    Asset filenames are content-hashed, so we discover a real built file at
    runtime instead of hardcoding a name. This is the Task 5.2 regression guard:
    before the StaticFiles mount these `_next/` requests returned 404.
    """

    static_dir = Path(kodeks.__file__).with_name("static")
    next_dir = static_dir / "_next"
    if not next_dir.is_dir():
        pytest.skip("no built static/_next assets present to serve")

    asset = next((path for path in next_dir.rglob("*") if path.is_file()), None)
    if asset is None:
        pytest.skip("no built static/_next assets present to serve")

    url_path = "/" + asset.relative_to(static_dir).as_posix()
    client = TestClient(create_app())
    res = client.get(url_path)
    assert res.status_code == 200, f"{url_path} returned {res.status_code}"
