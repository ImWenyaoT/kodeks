import importlib.util
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def load_build_backend():
    """Load the in-tree PEP 517 backend the same way build frontends do."""

    backend_path = REPO_ROOT / "build_backend" / "kodeks_build.py"
    spec = importlib.util.spec_from_file_location("kodeks_build", backend_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_in_tree_wheel_contains_runtime_assets_and_entrypoints(tmp_path):
    """Built wheels include Python runtime assets and console entry points."""

    wheel_name = load_build_backend().build_wheel(str(tmp_path))
    wheel_path = tmp_path / wheel_name

    with zipfile.ZipFile(wheel_path) as wheel:
        names = set(wheel.namelist())
        entry_points = wheel.read(
            "kodeks-0.1.0.dist-info/entry_points.txt"
        ).decode()
        metadata = wheel.read("kodeks-0.1.0.dist-info/METADATA").decode()
        record = wheel.read("kodeks-0.1.0.dist-info/RECORD").decode()

    assert "kodeks/app.py" in names
    assert "kodeks/server.py" in names
    assert "kodeks/smoke.py" in names
    assert "kodeks/static/index.html" in names
    assert "kodeks/py.typed" in names
    assert "kodeks-server = kodeks.server:main" in entry_points
    assert "kodeks-smoke = kodeks.smoke:main" in entry_points
    assert "Requires-Dist: httpx2>=2.3.0" in metadata
    assert "Requires-Dist: openai>=2.0.0" in metadata
    assert "kodeks/static/index.html,sha256=" in record
    assert "kodeks/py.typed,sha256=" in record


def test_in_tree_build_backend_supports_editable_installs(tmp_path):
    """Editable wheels expose the src layout for uv sync and local development."""

    wheel_name = load_build_backend().build_editable(str(tmp_path))
    wheel_path = tmp_path / wheel_name

    with zipfile.ZipFile(wheel_path) as wheel:
        names = set(wheel.namelist())
        pth = wheel.read("kodeks.pth").decode()
        entry_points = wheel.read(
            "kodeks-0.1.0.dist-info/entry_points.txt"
        ).decode()
        record = wheel.read("kodeks-0.1.0.dist-info/RECORD").decode()

    assert "kodeks.pth" in names
    assert str(REPO_ROOT / "src") in pth
    assert "kodeks-server = kodeks.server:main" in entry_points
    assert "kodeks.pth,sha256=" in record
