import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update

class RenewalTests(unittest.TestCase):
    def run_case(self, status='fetched', returned='rotated', extra=None):
        with tempfile.TemporaryDirectory() as td, contextlib.ExitStack() as stack:
            data_path, state_path = Path(td)/'data', Path(td)/'state'
            data_path.write_text('{}'); state_path.write_text('{}')
            env = {'HEALTH_APP_PASSWORD':'test', 'STATE_KEY':'x'*32, 'RENEW_WITHINGS':'1', 'WITHINGS_REFRESH_TOKEN':'replacement'}
            env.update(extra or {})
            stack.enter_context(patch.dict(os.environ, env, clear=True))
            stack.enter_context(patch.object(update, 'DATA_PATH', data_path))
            stack.enter_context(patch.object(update, 'STATE_PATH', state_path))
            stack.enter_context(patch.object(update.crypto, 'open_package', return_value=({'metrics':[], 'activities':[]}, None)))
            stack.enter_context(patch.object(update.crypto, 'open_state', return_value={'garmin':'current-garmin', 'withings_refresh':'old'}))
            stack.enter_context(patch.object(update.crypto, 'seal_state', side_effect=lambda state, key: dict(state)))
            stack.enter_context(patch.object(update, 'credentials', return_value={'garmin':'stale-garmin', 'withings_refresh':'replacement', 'cid':'client', 'secret':'secret'}))
            garmin=stack.enter_context(patch.object(update.sources, 'fetch_garmin', return_value=({'activities':None}, {'status':'fetched','from':'2026-11-13','to':'2026-11-19'}, 'current-garmin')))
            withings=stack.enter_context(patch.object(update.sources, 'fetch_withings', return_value=({}, {'status':status}, returned)))
            for name in ('merge_metrics','replace_activities','finalize'):
                stack.enter_context(patch.object(update.merge, name))
            with contextlib.redirect_stdout(io.StringIO()) as output:
                result=update.main()
            return result, json.loads(state_path.read_text()), garmin, withings, output.getvalue()

    def test_only_withings_replaced(self):
        code, state, garmin, withings, _ = self.run_case()
        self.assertEqual(code, 0)
        self.assertEqual(state, {'garmin':'current-garmin', 'withings_refresh':'rotated'})
        self.assertEqual(garmin.call_args.args[0], 'current-garmin')
        self.assertEqual(withings.call_args.args[2], 'replacement')

    def test_rejected_replacement_does_not_replace_state(self):
        code, state, *_ = self.run_case('auth_error','replacement')
        self.assertEqual(code, 1)
        self.assertEqual(state['withings_refresh'], 'old')

    def test_rotated_token_saved_after_measure_error(self):
        code, state, *_ = self.run_case('api_error','rotated')
        self.assertEqual(code, 1)
        self.assertEqual(state['withings_refresh'], 'rotated')

    def test_bootstrap_combination_blocked_before_provider_calls(self):
        code, state, garmin, withings, output = self.run_case(extra={'BOOTSTRAP':'1'})
        self.assertEqual(code, 1)
        garmin.assert_not_called(); withings.assert_not_called()
        self.assertIn('without_bootstrap', output)

    def test_missing_dedicated_secret_blocked(self):
        code, state, garmin, withings, output = self.run_case(extra={'WITHINGS_REFRESH_TOKEN':''})
        self.assertEqual(code, 1)
        garmin.assert_not_called(); withings.assert_not_called()
        self.assertIn('dedicated_secret', output)
