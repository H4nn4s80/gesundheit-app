"""Nur lesende Abrufe bei Garmin und Withings. Fehler werden als feste Kennungen gemeldet, nie als Rohtext."""
import json, logging, os, tempfile, time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

logging.disable(logging.CRITICAL)
TZ = ZoneInfo('Europe/Rome')
PAUSE = 1.4


class Blocked(Exception):
    pass


def _blocked_code(exc):
    for _ in range(6):
        if exc is None:
            break
        c = getattr(getattr(exc, 'response', None), 'status_code', None)
        if c in (403, 429):
            return c
        t = str(exc)
        if '429' in t or 'TooManyRequests' in type(exc).__name__:
            return 429
        if '403' in t:
            return 403
        exc = exc.__cause__ or exc.__context__
    return None


def fetch_garmin(tokens_json, end, daily_days, range_days=7):
    """Gibt (Rohdaten, Bericht, aktuelle Token) zurück. Rohdaten haben dieselbe Form wie die bisherigen Snapshots."""
    report = {'status': 'error', 'requests': 0, 'errors': []}
    raw = {'daily': {}, 'ranges': {}, 'activities': None}
    start = end - timedelta(days=range_days - 1)
    report.update({'from': start.isoformat(), 'to': end.isoformat()})
    new_tokens = tokens_json
    try:
        from garminconnect import Garmin
        api = Garmin(retry_attempts=0)
        original = api.connectapi

        def guarded(*args, **kwargs):
            time.sleep(PAUSE)
            report['requests'] += 1
            return original(*args, **kwargs)

        api.connectapi = guarded
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o700)
            path = os.path.join(tmp, 'garmin_tokens.json')
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(tokens_json)
            try:
                api.login(tokenstore=tmp)
            except Exception as e:
                c = _blocked_code(e)
                report.update(status='blocked', blocked=c) if c else report['errors'].append({'method': 'login', 'kind': type(e).__name__})
                return raw, report, new_tokens

            def get(name, *args):
                try:
                    return getattr(api, name)(*args)
                except Exception as e:
                    c = _blocked_code(e)
                    if c:
                        report.update(status='blocked', blocked=c)
                        raise Blocked() from None
                    report['errors'].append({'method': name, 'kind': type(e).__name__})
                    return None

            try:
                for offset in range(daily_days):
                    ds = (end - timedelta(days=daily_days - 1 - offset)).isoformat()
                    raw['daily'][ds] = {'stats': get('get_stats', ds), 'respiration': get('get_respiration_data', ds)}
                for method, key in [('get_sleep_daily', 'sleep_daily'), ('get_hrv_data_range', 'hrv_range'), ('get_body_battery', 'body_battery'),
                                    ('get_max_metrics_range', 'max_metrics_range'), ('get_weekly_training_status', 'training_status_weekly')]:
                    raw['ranges'][key] = get(method, start.isoformat(), end.isoformat())
                raw['ranges']['training_status'] = get('get_training_status', end.isoformat())
                acts = get('get_activities_by_date', start.isoformat(), end.isoformat())
                # None = Abruf fehlgeschlagen; nur eine echte Liste darf später bestehende Aktivitäten ersetzen.
                raw['activities'] = acts if isinstance(acts, list) else None
                report['status'] = 'partial' if report['errors'] else 'fetched'
            except Blocked:
                pass
            finally:
                try:
                    dumped = api.client.dumps()
                    if json.loads(dumped).get('di_refresh_token'):
                        new_tokens = dumped
                except Exception:
                    pass
    except Exception as e:
        report['errors'].append({'method': 'garmin', 'kind': type(e).__name__})
    return raw, report, new_tokens


WITHINGS_API = 'https://wbsapi.withings.net'
MEASTYPES = '1,6,76,77,88,11,91,155,167,170'


def _withings_post(report, path, **kwargs):
    """Retry explicit transient HTTP failures only; never retry API/auth errors.

    Transport timeouts are not retried because a refresh token might already
    have rotated without its response reaching us.
    """
    for attempt in range(3):
        time.sleep(PAUSE if attempt == 0 else 5 * attempt)
        report['requests'] += 1
        response = requests.post(WITHINGS_API + path, timeout=30, **kwargs)
        if response.status_code not in (502, 503, 504) or attempt == 2:
            return response


def _withings_body(response):
    if response.status_code != 200:
        return {}
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _withings_failure(report, response, body, auth=False):
    """Only fixed identifiers and numeric codes are safe for public logs."""
    http = response.status_code
    api = body.get('status')
    api = api if isinstance(api, int) and not isinstance(api, bool) else None
    report['http_status'] = http
    if api is not None:
        report['api_status'] = api
    if http in (403, 429) or api in (403, 429):
        report.update(status='blocked', blocked=http if http in (403, 429) else api)
    elif http != 200:
        report.update(status='http_error', code=http)
    elif api is None:
        report.update(status='invalid_response')
    elif api != 0:
        report.update(status='auth_error' if auth else 'api_error')
        if api is not None:
            report['code'] = api
        # Do not include the provider's raw error, which may contain secrets.
    else:
        report.update(status='invalid_response')


def fetch_withings(client_id, client_secret, refresh_token, end, days=7):
    """Gibt (Rohdaten, Bericht, neuer Refresh-Token) zurück. Der Refresh-Token wechselt bei jeder Nutzung."""
    report = {'status': 'error', 'requests': 0, 'errors': []}
    groups = []
    raw = {'measures_raw': {'status': 0, 'body': {'measuregrps': groups}}}
    new_refresh = refresh_token
    try:
        r = _withings_post(report, '/v2/oauth2', data={'action': 'requesttoken', 'grant_type': 'refresh_token',
                          'client_id': client_id, 'client_secret': client_secret, 'refresh_token': refresh_token})
        body = _withings_body(r)
        if r.status_code != 200 or body.get('status') != 0 or not (body.get('body') or {}).get('access_token'):
            _withings_failure(report, r, body, auth=True)
            return raw, report, new_refresh
        access = body['body']['access_token']
        new_refresh = body['body'].get('refresh_token') or refresh_token
        start = datetime.combine(end - timedelta(days=days - 1), datetime.min.time(), TZ)
        offset = None
        for _ in range(20):
            params = {'action': 'getmeas', 'category': '1', 'meastypes': MEASTYPES, 'startdate': str(int(start.timestamp())), 'enddate': str(int(time.time()))}
            if offset:
                params['offset'] = str(offset)
            r = _withings_post(report, '/measure', data=params, headers={'Authorization': 'Bearer ' + access})
            j = _withings_body(r)
            if r.status_code != 200 or j.get('status') != 0:
                _withings_failure(report, r, j)
                break
            b = j.get('body') or {}
            groups += b.get('measuregrps', [])
            offset = b.get('offset')
            if not b.get('more') or not offset:
                report['status'] = 'fetched'
                break
    except Exception as e:
        report['errors'].append({'method': 'withings', 'kind': type(e).__name__})
    return raw, report, new_refresh
