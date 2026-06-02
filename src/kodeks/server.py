"""Command-line server entrypoint for the Python Kodeks runtime."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

import uvicorn


def main(argv: Sequence[str] | None = None) -> int:
    """Start the Kodeks FastAPI server with uvicorn."""

    parser = argparse.ArgumentParser(description="Run the Kodeks FastAPI server.")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host interface for uvicorn to bind.",
    )
    parser.add_argument(
        "--port",
        default=8000,
        type=int,
        help="TCP port for uvicorn to bind.",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable uvicorn auto-reload for local development.",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="Uvicorn log level.",
    )
    args = parser.parse_args(argv)

    uvicorn.run(
        "kodeks.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level=args.log_level,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
