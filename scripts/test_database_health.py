import importlib.util
import io
import json
import ssl
import unittest
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from unittest.mock import Mock

from pathlib import Path

spec = importlib.util.spec_from_file_location("health", Path(__file__).with_name("database-health.py"))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

URL = "https://example.supabase.co"
NOW = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)


class Response(io.BytesIO):
    status = 200


def successful_run(age=timedelta(hours=1), **changes):
    return dict({"status": "completed", "conclusion": "success", "head_branch": "main",
                 "event": "schedule", "updated_at": (NOW - age).isoformat()}, **changes)


class HealthTests(unittest.TestCase):
    def test_only_json_true_is_healthy(self):
        for payload in (b"true", b" true\n"):
            health.probe(URL, "test-key", opener=lambda *a, **k: Response(payload))
        for payload in (b"false", b"1", b'"true"', b"null", b"{}", b"", b"<html>", b"x" * 4097):
            with self.subTest(payload=payload[:20]), self.assertRaises(health.ProbeError):
                health.probe(URL, "test-key", opener=lambda *a, **k: Response(payload))

    def test_request_is_bounded_read_only_rpc(self):
        opener = Mock(return_value=Response(b"true"))
        health.probe(URL + "/", "test-key", opener=opener)
        args, kwargs = opener.call_args
        request = args[0]
        self.assertEqual(request.full_url, URL + "/rest/v1/rpc/appraisal_health_check")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.data, b"{}")
        self.assertEqual(request.get_header("Apikey"), "test-key")
        self.assertEqual(kwargs["timeout"], 40)

    def test_bad_configuration_never_sends_credentials(self):
        opener = Mock()
        for url, key in (("", "key"), ("http://example.com", "key"),
                         ("https://user:pass@example.com", "key"),
                         (URL + "/other", "key"), (URL + "?x=1", "key"),
                         (URL + "#fragment", "key"), (URL, "")):
            with self.subTest(url=url), self.assertRaises(health.ProbeError):
                health.probe(url, key, opener=opener)
        opener.assert_not_called()

    def test_http_error_classification_and_no_response_leaks(self):
        for status in (301, 400, 401, 402, 403, 404, 408, 425, 429, 500, 502, 503, 504):
            opener = Mock(side_effect=HTTPError(URL, status, "private provider detail", {},
                                              io.BytesIO(b"private response")))
            with self.subTest(status=status), self.assertRaises(health.ProbeError) as caught:
                health.probe(URL, "test-key", opener=opener)
            self.assertEqual(caught.exception.retryable, status in (408, 425, 429) or status >= 500)
            self.assertNotIn("private", str(caught.exception))
            if status == 402:
                self.assertIn("restricted", str(caught.exception))

    def test_network_failures_retry_but_certificate_errors_do_not(self):
        for error, retryable in ((URLError("DNS private detail"), True), (TimeoutError(), True),
                                 (URLError(ssl.SSLCertVerificationError()), False)):
            with self.subTest(error=error), self.assertRaises(health.ProbeError) as caught:
                health.probe(URL, "test-key", opener=Mock(side_effect=error))
            self.assertEqual(caught.exception.retryable, retryable)

    def test_transient_failure_recovers(self):
        check = Mock(side_effect=[health.ProbeError("HTTP 503", True), None])
        sleep = Mock()
        health.ping(URL, "key", check=check, sleep=sleep, log=Mock())
        self.assertEqual(check.call_count, 2)
        sleep.assert_called_once_with(5)

    def test_retries_are_bounded(self):
        check = Mock(side_effect=health.ProbeError("HTTP 503", True))
        sleep = Mock()
        with self.assertRaises(health.ProbeError):
            health.ping(URL, "key", check=check, sleep=sleep, log=Mock())
        self.assertEqual(check.call_count, 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 15, 30])

    def test_permanent_failure_stops_without_sleep(self):
        check = Mock(side_effect=health.ProbeError("HTTP 402"))
        sleep = Mock()
        with self.assertRaises(health.ProbeError):
            health.ping(URL, "key", check=check, sleep=sleep, log=Mock())
        check.assert_called_once()
        sleep.assert_not_called()

    def test_success_needs_no_retry(self):
        check, sleep = Mock(), Mock()
        health.ping(URL, "key", check=check, sleep=sleep, log=Mock())
        check.assert_called_once()
        sleep.assert_not_called()

    def test_redirects_are_refused(self):
        self.assertIsNone(health.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.test"))


class WatchdogTests(unittest.TestCase):
    def test_recent_primary_success_skips_backup(self):
        self.assertFalse(health.probe_required([successful_run()], NOW, "main"))

    def test_missing_or_stale_success_requires_backup(self):
        self.assertTrue(health.probe_required([], NOW, "main"))
        for age in (timedelta(hours=10), timedelta(days=1), timedelta(minutes=-1)):
            self.assertTrue(health.probe_required([successful_run(age)], NOW, "main"))

    def test_failure_other_branch_and_unfinished_runs_never_suppress_backup(self):
        for changes in ({"conclusion": "failure"}, {"head_branch": "feature"},
                        {"event": "pull_request"}, {"status": "in_progress"},
                        {"updated_at": "invalid"}, {"updated_at": None}):
            run = successful_run()
            run.update(changes)
            with self.subTest(changes=changes):
                self.assertTrue(health.probe_required([run], NOW, "main"))

    def test_history_request_is_scoped_to_primary_and_branch(self):
        opener = Mock(return_value=Response(json.dumps({"workflow_runs": [successful_run()]}).encode()))
        self.assertFalse(health.watchdog("owner/repo", "private-token", "main", opener, NOW, Mock()))
        request = opener.call_args.args[0]
        self.assertIn("/workflows/keep-alive.yml/runs?", request.full_url)
        self.assertIn("branch=main", request.full_url)
        self.assertIn("status=success", request.full_url)

    def test_history_api_failure_runs_backup_instead_of_skipping(self):
        for error in (URLError("private-token"), TimeoutError(), ValueError("bad JSON")):
            log = Mock()
            self.assertTrue(health.watchdog("owner/repo", "private-token", "main",
                                           Mock(side_effect=error), NOW, log))
            self.assertNotIn("private-token", str(log.call_args))


if __name__ == "__main__":
    unittest.main()
