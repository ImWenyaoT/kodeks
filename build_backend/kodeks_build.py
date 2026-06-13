"""PEP 517 build backend for the dependency-free Kodeks package build."""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import tarfile
import tomllib
import zipfile
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1]


def build_wheel(
    wheel_directory: str,
    config_settings: dict[str, Any] | None = None,
    metadata_directory: str | None = None,
) -> str:
    """Build a pure-Python wheel without downloading a build backend."""

    project = read_project_metadata()
    dist_info = f"{normalized_name(project['name'])}-{project['version']}.dist-info"
    wheel_name = (
        f"{normalized_name(project['name'])}-{project['version']}-py3-none-any.whl"
    )
    wheel_path = Path(wheel_directory) / wheel_name
    records: list[tuple[str, bytes]] = []

    with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as wheel:
        for source in package_files():
            arcname = source.relative_to(ROOT / "src").as_posix()
            write_wheel_file(wheel, records, arcname, source.read_bytes())

        write_wheel_file(wheel, records, f"{dist_info}/METADATA", metadata(project))
        write_wheel_file(wheel, records, f"{dist_info}/WHEEL", wheel_metadata())
        write_wheel_file(
            wheel,
            records,
            f"{dist_info}/entry_points.txt",
            entry_points(project),
        )
        record_path = f"{dist_info}/RECORD"
        wheel.writestr(record_path, wheel_record(records, record_path))

    return wheel_name


def build_sdist(
    sdist_directory: str,
    config_settings: dict[str, Any] | None = None,
) -> str:
    """Build a source distribution containing package, tests, and docs."""

    project = read_project_metadata()
    archive_root = f"{project['name']}-{project['version']}"
    sdist_name = f"{archive_root}.tar.gz"
    sdist_path = Path(sdist_directory) / sdist_name

    with tarfile.open(sdist_path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for source in sdist_files():
            arcname = f"{archive_root}/{source.relative_to(ROOT).as_posix()}"
            archive.add(source, arcname=arcname, recursive=False)
        pkg_info = tarfile.TarInfo(f"{archive_root}/PKG-INFO")
        pkg_info_bytes = metadata(project)
        pkg_info.size = len(pkg_info_bytes)
        archive.addfile(pkg_info, io.BytesIO(pkg_info_bytes))

    return sdist_name


def build_editable(
    wheel_directory: str,
    config_settings: dict[str, Any] | None = None,
    metadata_directory: str | None = None,
) -> str:
    """Build a PEP 660 editable wheel that points imports at `src/`."""

    project = read_project_metadata()
    dist_info = f"{normalized_name(project['name'])}-{project['version']}.dist-info"
    wheel_name = (
        f"{normalized_name(project['name'])}-{project['version']}-py3-none-any.whl"
    )
    wheel_path = Path(wheel_directory) / wheel_name
    records: list[tuple[str, bytes]] = []

    with zipfile.ZipFile(wheel_path, "w", compression=zipfile.ZIP_DEFLATED) as wheel:
        write_wheel_file(
            wheel,
            records,
            f"{normalized_name(project['name'])}.pth",
            f"{ROOT / 'src'}\n".encode(),
        )
        write_wheel_file(wheel, records, f"{dist_info}/METADATA", metadata(project))
        write_wheel_file(wheel, records, f"{dist_info}/WHEEL", wheel_metadata())
        write_wheel_file(
            wheel,
            records,
            f"{dist_info}/entry_points.txt",
            entry_points(project),
        )
        record_path = f"{dist_info}/RECORD"
        wheel.writestr(record_path, wheel_record(records, record_path))

    return wheel_name


def get_requires_for_build_wheel(
    config_settings: dict[str, Any] | None = None,
) -> list[str]:
    """Return no build requirements so `uv build` works offline."""

    return []


def get_requires_for_build_editable(
    config_settings: dict[str, Any] | None = None,
) -> list[str]:
    """Return no build requirements so editable installs work offline."""

    return []


def get_requires_for_build_sdist(
    config_settings: dict[str, Any] | None = None,
) -> list[str]:
    """Return no build requirements so source builds work offline."""

    return []


def prepare_metadata_for_build_editable(
    metadata_directory: str,
    config_settings: dict[str, Any] | None = None,
) -> str:
    """Write editable wheel metadata before building an editable wheel."""

    return prepare_metadata_for_build_wheel(metadata_directory, config_settings)


def prepare_metadata_for_build_wheel(
    metadata_directory: str,
    config_settings: dict[str, Any] | None = None,
) -> str:
    """Write wheel metadata for installers that request it before building."""

    project = read_project_metadata()
    dist_info = f"{normalized_name(project['name'])}-{project['version']}.dist-info"
    target = Path(metadata_directory) / dist_info
    target.mkdir(parents=True, exist_ok=True)
    (target / "METADATA").write_bytes(metadata(project))
    (target / "WHEEL").write_bytes(wheel_metadata())
    (target / "entry_points.txt").write_bytes(entry_points(project))
    return dist_info


def read_project_metadata() -> dict[str, Any]:
    """Read the static project metadata from `pyproject.toml`."""

    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())
    project = pyproject.get("project")
    if not isinstance(project, dict):
        raise ValueError("pyproject.toml must contain a [project] table")
    return cast(dict[str, Any], project)


def package_files() -> list[Path]:
    """Return package files that belong in the wheel."""

    return sorted(
        path
        for path in (ROOT / "src" / "kodeks").rglob("*")
        if is_source_file(path)
    )


def sdist_files() -> list[Path]:
    """Return source files that belong in the source distribution."""

    roots = [
        ROOT / "build_backend",
        ROOT / "docs",
        ROOT / "src",
        ROOT / "tests",
    ]
    files = [
        ROOT / "LICENSE",
        ROOT / "README.md",
        ROOT / "README.zh-CN.md",
        ROOT / "pyproject.toml",
        ROOT / "uv.lock",
    ]
    for root in roots:
        if root.exists():
            files.extend(path for path in root.rglob("*") if is_source_file(path))
    return sorted(path for path in files if path.exists() and is_source_file(path))


def is_source_file(path: Path) -> bool:
    """Return whether a path is an intentional package/source artifact."""

    if not path.is_file():
        return False
    if "__pycache__" in path.parts:
        return False
    return path.suffix not in {".pyc", ".pyo"}


def metadata(project: dict[str, Any]) -> bytes:
    """Render core package metadata for wheel and source distributions."""

    name = metadata_string(project, "name")
    version = metadata_string(project, "version")
    description = metadata_string(project, "description")
    requires_python = metadata_string(project, "requires-python")
    readme_path = metadata_string(project, "readme")
    lines = [
        "Metadata-Version: 2.3",
        f"Name: {name}",
        f"Version: {version}",
        f"Summary: {description}",
        f"Requires-Python: {requires_python}",
        "Description-Content-Type: text/markdown",
    ]
    for dependency in project.get("dependencies", []):
        lines.append(f"Requires-Dist: {dependency}")
    readme = (ROOT / readme_path).read_text()
    body = "\n".join(lines) + "\n\n" + readme
    return body.encode()


def metadata_string(project: dict[str, Any], key: str) -> str:
    """Read one required string field from project metadata."""

    value = project.get(key)
    if not isinstance(value, str):
        raise ValueError(f"project.{key} must be a string")
    return value


def wheel_metadata() -> bytes:
    """Render the `.dist-info/WHEEL` file for a pure Python wheel."""

    return (
        b"Wheel-Version: 1.0\n"
        b"Generator: kodeks-build\n"
        b"Root-Is-Purelib: true\n"
        b"Tag: py3-none-any\n"
    )


def entry_points(project: dict[str, Any]) -> bytes:
    """Render console script entry points from project metadata."""

    scripts = project.get("scripts", {})
    if not scripts:
        return b""
    lines = ["[console_scripts]"]
    lines.extend(f"{name} = {target}" for name, target in sorted(scripts.items()))
    return ("\n".join(lines) + "\n").encode()


def write_wheel_file(
    wheel: zipfile.ZipFile,
    records: list[tuple[str, bytes]],
    arcname: str,
    content: bytes,
) -> None:
    """Write one wheel member and remember its RECORD digest."""

    wheel.writestr(arcname, content)
    records.append((arcname, content))


def wheel_record(records: list[tuple[str, bytes]], record_path: str) -> str:
    """Render a standards-compatible wheel RECORD file."""

    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")
    for arcname, content in records:
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=")
        writer.writerow([arcname, f"sha256={digest.decode()}", str(len(content))])
    writer.writerow([record_path, "", ""])
    return output.getvalue()


def normalized_name(name: str) -> str:
    """Normalize a project name for wheel filenames and dist-info paths."""

    return name.replace("-", "_").replace(".", "_")
