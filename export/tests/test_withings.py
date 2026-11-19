import sys
import unittest
from pathlib import Path
from datetime import date
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sources


def response(http=200, body=None):
    return Mock(status_code=http, json=Mock(return_value=body))

class WithingsTests(unittest.TestCase):
    def fetch(self, replies):
        with patch.object(sources.time, 'sleep'), patch.object(sources.requests, 'post', side_effect=replies) as post:
            result = sources.fetch_withings('client', 'secret', 'old', date(2026, 11, 19))
        return result, post.call_count

    def test_transient_http_then_success(self):
        result, calls = self.fetch([response(503), response(body={'status': 0, 'body': {'access_token': 'access', 'refresh_token': 'new'}}), response(body={'status': 0, 'body': {'measuregrps': []}})])
        self.assertEqual((result[1]['status'], result[2], calls), ('fetched', 'new', 3))

    def test_api_503_not_retried_or_confused_with_http(self):
        result, calls = self.fetch([response(body={'status': 503, 'error': 'secret old client'})])
        report = result[1]
        self.assertEqual((report['status'], report['http_status'], report['api_status'], calls), ('auth_error', 200, 503, 1))
        self.assertNotIn('secret', str(report))
        self.assertEqual(result[2], 'old')

    def test_auth_reason_is_allowlisted_not_raw(self):
        result, calls = self.fetch([response(body={'status': 503, 'error': 'Invalid Params: invalid client id/secret secret-value'})])
        self.assertEqual(result[1]['reason'], 'invalid_client_credentials')
        self.assertNotIn('secret-value', str(result[1]))

    def test_http_retry_bounded(self):
        result, calls = self.fetch([response(503)] * 3)
        self.assertEqual((result[1]['status'], result[1]['http_status'], calls), ('http_error', 503, 3))
        self.assertNotIn('api_status', result[1])

    def test_blocked_not_retried(self):
        for code in (403, 429):
            result, calls = self.fetch([response(code)])
            self.assertEqual((result[1]['status'], calls), ('blocked', 1))

    def test_timeout_not_retried(self):
        result, calls = self.fetch([sources.requests.Timeout('secret')])
        self.assertEqual(calls, 1)
        self.assertNotIn('secret', str(result[1]))
        self.assertEqual(result[2], 'old')

    def test_rotated_token_preserved_after_measure_failure(self):
        result, calls = self.fetch([response(body={'status': 0, 'body': {'access_token': 'access', 'refresh_token': 'new'}}), response(body={'status': 429})])
        self.assertEqual((result[1]['status'], result[1]['blocked'], result[2]), ('blocked', 429, 'new'))

    def test_invalid_json_safe(self):
        r = response()
        r.json.side_effect = ValueError('secret')
        result, calls = self.fetch([r])
        self.assertEqual(calls, 1)
        self.assertNotIn('secret', str(result[1]))

if __name__ == '__main__':
    unittest.main()
