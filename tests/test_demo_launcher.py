"""Exercise supervision with local HTTP stand-ins, without loading Mac models."""
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts/demo-up.sh"
PORTS = (8787, 8765, 43123)


class DemoLauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hackday launcher ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, "SENSE_MLX_DIR": str(self.root / "mlx"), "DEMO_START_TIMEOUT": "3"}

    def run_script(self):
        return subprocess.run([str(SCRIPT)], env=self.env, text=True, capture_output=True, timeout=15)

    def test_missing_checkout_fails(self):
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MLX directory missing", result.stderr)

    def test_missing_venv_fails(self):
        (self.root / "mlx").mkdir()
        self.env["SENSE_PYTHON"] = str(self.root / "missing/python")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Sense venv missing", result.stderr)

    def fixtures(self):
        for port in PORTS:
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    sock.bind(("127.0.0.1", port))
                except OSError:
                    self.skipTest(f"Port {port} is occupied; stop dev services for launcher smoke tests")
        mlx = self.root / "mlx"
        (mlx / "scripts").mkdir(parents=True)
        service = self.root / "service.py"
        service.write_text('''from http.server import BaseHTTPRequestHandler, HTTPServer
import sys
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"vault_present":true,"item_count":3,"embeddings":"offline"}')
HTTPServer.allow_reuse_address = True
HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
''')
        # Preserve Python's process-group launcher, replacing only the service commands.
        python = self.root / "python"
        python.write_text(f'''#!/usr/bin/env bash
if [[ "$1" == '-c' && "$2" == 'import uvicorn, sense.app' ]]; then exit 0; fi
if [[ "$1" == '-m' && "$2" == 'uvicorn' ]]; then
  exec {shlex.quote(sys.executable)} {shlex.quote(str(service))} 8765
fi
exec {shlex.quote(sys.executable)} "$@"
''')
        python.chmod(0o755)
        npm = self.root / "npm"
        npm.write_text(f"#!/usr/bin/env bash\nexec {shlex.quote(sys.executable)} {shlex.quote(str(service))} 43123\n")
        npm.chmod(0o755)
        (mlx / "scripts/serve.sh").write_text(f"exec {shlex.quote(sys.executable)} {shlex.quote(str(service))} 8787\n")
        self.env.update(SENSE_PYTHON=str(python), SENSE_MLX_PYTHON=str(python), PATH=f"{self.root}:{os.environ['PATH']}")
        self.env.pop("SENSE_MLX_START_CMD", None)

    def assert_ports_released(self):
        for port in PORTS:
            with socket.socket() as sock:
                self.assertNotEqual(sock.connect_ex(("127.0.0.1", port)), 0, f"Service on {port} leaked")

    def test_occupied_port_does_not_kill_owner(self):
        self.fixtures()
        with socket.socket() as owner:
            owner.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            owner.bind(("127.0.0.1", 8787))
            owner.listen()
            result = self.run_script()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("port 8787 is already in use", result.stderr)
            self.assertEqual(owner.fileno() >= 0, True)

    def test_startup_timeout_cleans_children(self):
        self.fixtures()
        self.env["SENSE_MLX_START_CMD"] = "exec sleep 30"
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mlx did not become ready", result.stderr)
        self.assert_ports_released()

    def test_sources_do_and_gemini_env_when_present(self):
        do_file = REPO / ".do.env"
        gemini_file = REPO / ".gemini.env"
        if do_file.exists() or gemini_file.exists():
            self.skipTest("local planner env files are present")
        self.fixtures()
        marker = self.root / "seen-env.json"
        service = self.root / "service.py"
        service.write_text(
            "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text(json.dumps({{\n"
            '    "DO_MODEL_KEY": os.environ.get("DO_MODEL_KEY", ""),\n'
            '    "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),\n'
            "}))\n"
            "class Handler(BaseHTTPRequestHandler):\n"
            "    def do_GET(self):\n"
            "        self.send_response(200)\n"
            "        self.send_header('Content-Type', 'application/json')\n"
            "        self.end_headers()\n"
            "        self.wfile.write(b'{\"vault_present\":true,\"item_count\":3,\"embeddings\":\"offline\"}')\n"
            "HTTPServer.allow_reuse_address = True\n"
            "HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()\n"
        )
        do_file.write_text("DO_MODEL_KEY=test-do-not-a-secret\n")
        gemini_file.write_text("GEMINI_API_KEY=test-gemini-not-a-secret\n")
        self.addCleanup(do_file.unlink, missing_ok=True)
        self.addCleanup(gemini_file.unlink, missing_ok=True)
        with tempfile.TemporaryFile(mode="w+") as output:
            process = subprocess.Popen(
                [str(SCRIPT)], env=self.env, stdout=output, stderr=output, start_new_session=True
            )
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if marker.is_file():
                        break
                    if process.poll() is not None:
                        output.seek(0)
                        self.fail(f"Launcher exited before env was visible:\n{output.read()}")
                    time.sleep(0.1)
                else:
                    output.seek(0)
                    self.fail(f"Child did not observe planner env:\n{output.read()}")
                seen = json.loads(marker.read_text())
                self.assertEqual(seen["DO_MODEL_KEY"], "test-do-not-a-secret")
                self.assertEqual(seen["GEMINI_API_KEY"], "test-gemini-not-a-secret")
            finally:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
        self.assert_ports_released()

    def test_full_start_health_and_shutdown(self):
        self.fixtures()
        with tempfile.TemporaryFile(mode="w+") as output:
            process = subprocess.Popen([str(SCRIPT)], env=self.env, stdout=output, stderr=output, start_new_session=True)
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    output.seek(0)
                    if "Press Ctrl-C" in output.read():
                        break
                    if process.poll() is not None:
                        self.fail("Launcher exited before readiness")
                    time.sleep(0.1)
                else:
                    self.fail("Launcher did not report readiness")
                with urlopen("http://127.0.0.1:8765/health", timeout=2) as response:
                    self.assertEqual(json.load(response)["item_count"], 3)
                output.seek(0)
                self.assertIn("Editor http://127.0.0.1:43123", output.read())
            finally:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
        self.assert_ports_released()


if __name__ == "__main__":
    unittest.main()
