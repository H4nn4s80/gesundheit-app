#!/usr/bin/env python3
"""Ein Export-Lauf: Datenpaket öffnen, Garmin und Withings abrufen, einmischen, prüfen, neu verschlüsseln.

Ausgabe: genau eine Statuszeile ohne Messwerte, Token oder Rohfehler (das Protokoll ist öffentlich einsehbar).
Umgebung: HEALTH_APP_PASSWORD, STATE_KEY und ZUGANGSDATEN (die Übergabedatei als JSON mit garmin_tokens_json,
withings_client_id, withings_client_secret, withings_refresh_token). Statt ZUGANGSDATEN gehen auch die Einzelwerte
GARMIN_TOKENS, WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET, WITHINGS_REFRESH_TOKEN.
"""
import json, os, sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import crypto, merge, sources
from canonical_data import digest

TZ = ZoneInfo('Europe/Rome')
DATA_PATH = Path(os.environ.get('DATA_PATH') or HERE.parent / 'data.enc.json')
STATE_PATH = Path(os.environ.get('STATE_PATH') or HERE / 'state' / 'token.enc.json')


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(obj, separators=(',', ':')))
    tmp.replace(path)


def credentials():
    """Zugangsdaten aus ZUGANGSDATEN (ganze Übergabedatei) oder aus den Einzelwerten."""
    c = {'garmin': os.environ.get('GARMIN_TOKENS', '').strip(), 'withings_refresh': os.environ.get('WITHINGS_REFRESH_TOKEN', '').strip(),
         'cid': os.environ.get('WITHINGS_CLIENT_ID', '').strip(), 'secret': os.environ.get('WITHINGS_CLIENT_SECRET', '').strip()}
    blob = os.environ.get('ZUGANGSDATEN', '').strip()
    if blob:
        try:
            j = json.loads(blob)
        except Exception:
            raise RuntimeError('zugangsdaten_invalid') from None
        g = j.get('garmin_tokens_json')
        c['garmin'] = c['garmin'] or (json.dumps(g) if isinstance(g, dict) else str(g or '').strip())
        c['withings_refresh'] = c['withings_refresh'] or str(j.get('withings_refresh_token') or '').strip()
        c['cid'] = c['cid'] or str(j.get('withings_client_id') or '').strip()
        c['secret'] = c['secret'] or str(j.get('withings_client_secret') or '').strip()
    return c


def counts(data):
    return {'metrics': len(data['metrics']), 'points': sum(len(m['points']) for m in data['metrics']), 'activities': len(data.get('activities') or [])}


def check(before, after, window_acts):
    """Schutz vor Datenverlust: Kennzahlen dürfen nicht verschwinden, Messpunkte nicht schrumpfen,
    Aktivitäten höchstens um die Zahl derer abnehmen, die im Abruf-Zeitraum lagen."""
    if after['metrics'] < before['metrics'] or after['points'] < before['points']:
        return False
    return after['activities'] >= before['activities'] - window_acts


def main():
    info = {'providers': {}, 'changed': False, 'published': False}
    code = 1
    try:
        password, state_key = os.environ.get('HEALTH_APP_PASSWORD', ''), os.environ.get('STATE_KEY', '')
        if not password or not state_key:
            raise RuntimeError('secrets_missing')
        if len(state_key) < 32:
            raise RuntimeError('state_key_too_short')
        envelope = json.loads(DATA_PATH.read_text())
        try:
            data, key = crypto.open_package(envelope, password)
        except Exception:
            raise RuntimeError('password_mismatch') from None
        before_hash, before = digest(data), counts(data)
        cred = credentials()

        renew_withings = os.environ.get('RENEW_WITHINGS') == '1'
        if renew_withings and (os.environ.get('BOOTSTRAP') == '1' or not STATE_PATH.exists()):
            raise RuntimeError('withings_renewal_requires_existing_state_without_bootstrap')
        if renew_withings and not os.environ.get('WITHINGS_REFRESH_TOKEN', '').strip():
            raise RuntimeError('withings_renewal_requires_dedicated_secret')

        if STATE_PATH.exists() and os.environ.get('BOOTSTRAP') != '1':
            try:
                state = crypto.open_state(json.loads(STATE_PATH.read_text()), state_key)
            except Exception:
                raise RuntimeError('state_key_mismatch') from None
        else:
            state = {'garmin': cred['garmin'], 'withings_refresh': cred['withings_refresh']}
            info['bootstrap'] = True

        now = datetime.now(TZ)
        end = now.date()
        full = os.environ.get('FULL') == '1' or now.hour < 6 or info.get('bootstrap')
        garmin_raw = withings_raw = None

        if state.get('garmin'):
            garmin_raw, rep, state['garmin'] = sources.fetch_garmin(state['garmin'], end, daily_days=7 if full else 2)
            info['providers']['garmin'] = rep
            write_json(STATE_PATH, crypto.seal_state(state, state_key))
        else:
            info['providers']['garmin'] = {'status': 'no_token'}
        cid, secret = cred['cid'], cred['secret']
        candidate = cred['withings_refresh'] if renew_withings else state.get('withings_refresh')
        if candidate and cid and secret:
            withings_raw, rep, refreshed = sources.fetch_withings(cid, secret, candidate, end)
            # A rejected replacement must not overwrite the existing token state.
            if not renew_withings or refreshed != candidate or rep.get('status') == 'fetched':
                state['withings_refresh'] = refreshed
            info['providers']['withings'] = rep
            # Sofort sichern: der alte Refresh-Token ist nach der Nutzung ungültig.
            write_json(STATE_PATH, crypto.seal_state(state, state_key))
        else:
            info['providers']['withings'] = {'status': 'no_token'}

        ok = {s: info['providers'][s].get('status') in ('fetched', 'partial') for s in ('garmin', 'withings')}
        window_acts = 0
        if ok['garmin'] or ok['withings']:
            merge.merge_metrics(data, garmin_raw if ok['garmin'] else None, withings_raw if ok['withings'] else None)
            if ok['garmin']:
                g = info['providers']['garmin']
                window_acts = sum(1 for a in data.get('activities') or [] if g['from'] <= a.get('date', '') <= g['to'])
                merge.replace_activities(data, garmin_raw.get('activities'), g['from'], g['to'])
            merge.finalize(data)
            after = counts(data)
            if not check(before, after, window_acts):
                raise RuntimeError('validation_failed')
            info['counts'] = after
            if digest(data) != before_hash:
                info['changed'] = True
                stamp = datetime.now(ZoneInfo('Europe/Berlin')).isoformat()
                data['built'] = data['fetched_at'] = stamp
                package = crypto.seal_package(data, key, envelope['salt'])
                check_data, _ = crypto.open_package(package, password)
                if digest(check_data) != digest(data):
                    raise RuntimeError('roundtrip_failed')
                if os.environ.get('DRY_RUN') != '1':
                    write_json(DATA_PATH, package)
                    info['published'] = True
        code = 0 if all(ok.values()) else 1
    except RuntimeError as e:
        info['error'] = str(e)
    except Exception as e:
        info['error'] = 'update_failed:' + type(e).__name__
    status = 'error' if 'error' in info else ('changed' if info['changed'] else 'unchanged')
    print(f'STATUS={status} ' + json.dumps(info, ensure_ascii=False, separators=(',', ':')))
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write(f"published={'true' if info['published'] else 'false'}\n")
    return code


if __name__ == '__main__':
    sys.exit(main())
