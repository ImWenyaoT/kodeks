import unittest

from fastapi.testclient import TestClient

from kodeks.main import app, create_app


class HealthRouteTest(unittest.TestCase):
    def test_health_endpoint_returns_ok(self) -> None:
        """Verify the health route stays independent from model/provider state."""

        response = TestClient(app).get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_create_app_registers_expected_routes(self) -> None:
        """Verify app construction wires the public API route prefixes."""

        route_paths = {route.path for route in create_app().routes}

        self.assertIn("/health", route_paths)
        self.assertIn("/api/chat/stream", route_paths)
        self.assertIn("/api/workspace/files", route_paths)
        self.assertIn("/api/shell/run", route_paths)
        self.assertIn("/api/approvals/{approval_id}", route_paths)


if __name__ == "__main__":
    unittest.main()
