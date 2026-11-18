"""Frische Abrufe in den bestehenden Datenbestand einmischen. Entspricht der bisherigen Logik (recent_export),
liest aber aus dem Speicher statt aus Snapshot-Dateien und ersetzt Aktivitäten im Abruf-Zeitraum."""
import math
from datetime import datetime
from zoneinfo import ZoneInfo

from extend_export import STATUS, activity_record, ingest_training_status
from vo2_attribution import finalize_vo2_metrics

TZ = ZoneInfo('Europe/Rome')


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def merge_metrics(data, garmin=None, withings=None):
    defs = {m['id']: m for m in data['metrics']}
    maps = {m['id']: {p['date']: p for p in m['points']} for m in data['metrics']}

    def add(k, d, v, source, note=None):
        if k not in defs or not d or not _num(v) or v < 0:
            return
        p = {'date': d, 'value': round(v, 3), 'unit': defs[k]['unit'], 'source': source}
        if note:
            p['note'] = note
        maps[k][d] = p

    if garmin:
        daily = garmin.get('daily') or {}
        ranges = garmin.get('ranges') or {}
        for d, row in daily.items():
            s = row.get('stats') or {}
            resp = row.get('respiration') or {}
            for field, k, scale in [('totalSteps', 'steps', 1), ('activeKilocalories', 'energy', 1), ('totalDistanceMeters', 'distance', .001), ('floorsAscended', 'floors', 1),
                                    ('restingHeartRate', 'rest', 1), ('minHeartRate', 'hrmin', 1), ('maxHeartRate', 'hrmax', 1), ('averageStressLevel', 'stress', 1), ('averageSpo2', 'spo2', 1),
                                    ('bodyBatteryHighestValue', 'bbhigh', 1), ('bodyBatteryLowestValue', 'bblow', 1), ('bodyBatteryChargedValue', 'bbcharged', 1)]:
                v = s.get(field)
                add(k, d, v * scale if _num(v) else None, 'Garmin')
            if s.get('moderateIntensityMinutes') is not None or s.get('vigorousIntensityMinutes') is not None:
                add('intensity', d, (s.get('moderateIntensityMinutes') or 0) + (s.get('vigorousIntensityMinutes') or 0), 'Garmin')
            for f, k in [('avgWakingRespirationValue', 'respawake'), ('avgSleepRespirationValue', 'respsleep')]:
                add(k, d, resp.get(f), 'Garmin')
        for row in ranges.get('sleep_daily') or []:
            d = row.get('calendarDate')
            v = row.get('values') or {}
            for f, k, scale in [('totalSleepTimeInSeconds', 'sleep', 1 / 3600), ('deepTime', 'deep', 1 / 3600), ('remTime', 'rem', 1 / 3600), ('sleepScore', 'score', 1), ('respiration', 'respsleep', 1)]:
                x = v.get(f)
                add(k, d, x * scale if _num(x) else None, 'Garmin')
        for row in (ranges.get('hrv_range') or {}).get('hrvSummaries', []):
            base = row.get('baseline') or {}
            note = 'Status: ' + STATUS.get(row.get('status'), 'Nicht eingeordnet')
            if base.get('balancedLow') is not None and base.get('balancedUpper') is not None:
                note += f" · Basisbereich: {base['balancedLow']}–{base['balancedUpper']} ms"
            add('hrv', row.get('calendarDate'), row.get('lastNightAvg'), 'Garmin', note)
        for row in ranges.get('body_battery') or []:
            d = row.get('date')
            s = (daily.get(d) or {}).get('stats') or {}
            vals = [a[1] for a in row.get('bodyBatteryValuesArray', []) if _num(a[1]) and a[1] >= 0]
            for k, field, value in [('bbhigh', 'bodyBatteryHighestValue', max(vals) if vals else None), ('bblow', 'bodyBatteryLowestValue', min(vals) if vals else None), ('bbcharged', 'bodyBatteryChargedValue', row.get('charged'))]:
                if s.get(field) is None:
                    add(k, d, value, 'Garmin')
        for row in ranges.get('max_metrics_range') or []:
            for field, k in [('generic', 'vo2run'), ('rowing', 'vo2row')]:
                v = row.get(field) or {}
                add(k, v.get('calendarDate'), v.get('vo2MaxPreciseValue', v.get('vo2MaxValue')), 'Garmin', 'Garmin allgemein; Sportzuordnung nicht separat bestätigt' if field == 'generic' else None)
        training = {x['date']: x for x in (data.get('training') or []) if isinstance(x, dict) and x.get('date')}
        ingest_training_status(ranges, lambda k, d, v, note=None: add(k, d, v, 'Garmin', note), training)
        data['training'] = sorted(training.values(), key=lambda a: a['date'], reverse=True)
        merge_sleep_schedule(data, ranges)

    if withings:
        groups = (withings.get('measures_raw') or {}).get('body', {}).get('measuregrps', [])
        for g in sorted(groups, key=lambda g: g['date']):
            if g.get('attrib') in (1, 4) or g.get('category', 1) != 1:
                continue
            vs = {m['type']: m['value'] * 10 ** m['unit'] for m in g.get('measures', [])}
            if 9 in vs or 10 in vs:
                continue
            d = datetime.fromtimestamp(g['date'], TZ).date().isoformat()
            for t, k in {1: 'weight', 6: 'fat', 76: 'muscle', 88: 'bone', 11: 'pulse', 170: 'visceral', 91: 'pwv', 155: 'vascular', 167: 'nerve'}.items():
                add(k, d, vs.get(t), 'Withings')
            if vs.get(1) and 77 in vs:
                add('water', d, vs[77] / vs[1] * 100, 'Withings')

    for m in data['metrics']:
        m['points'] = [p for _, p in sorted(maps[m['id']].items())]
    return data


def merge_sleep_schedule(data, ranges):
    rows = {r['date']: r for r in (data.get('sleepSchedule') or []) if isinstance(r, dict) and r.get('date')}
    for row in ranges.get('sleep_daily') or []:
        v = row.get('values') or {}
        day, start, end = row.get('calendarDate') or row.get('date'), v.get('gmtSleepStartTimeInMillis'), v.get('gmtSleepEndTimeInMillis')
        if not isinstance(day, str) or not _num(start) or not _num(end) or not (0 < end - start <= 20 * 3600 * 1000):
            continue
        try:
            a, b = datetime.fromtimestamp(start / 1000, TZ), datetime.fromtimestamp(end / 1000, TZ)
        except (ValueError, OverflowError, OSError):
            continue
        if 2010 <= a.year <= 2100 and b.date().isoformat() == day:
            rows[day] = {'date': day, 'start': a.isoformat(), 'end': b.isoformat(), 'source': 'Garmin'}
    data['sleepSchedule'] = [rows[d] for d in sorted(rows)]


def replace_activities(data, fetched, start, end):
    """Aktivitäten im Zeitraum [start, end] durch den aktuellen Garmin-Stand ersetzen.
    So verschwinden in Connect gelöschte Einheiten. `fetched` muss eine echte Liste sein (None = Abruf fehlgeschlagen)."""
    if not isinstance(fetched, list):
        return data
    fresh = {}
    for a in fetched:
        local = a.get('startTimeLocal')
        if not local or not (start <= local[:10] <= end):
            continue
        fresh[a.get('activityId') or (local, (a.get('activityType') or {}).get('typeKey'))] = activity_record(a)
    keep = [a for a in data.get('activities') or [] if not (start <= a.get('date', '') <= end)]
    data['activities'] = sorted(keep + list(fresh.values()), key=lambda a: (a['date'], a.get('time') or ''), reverse=True)
    return data


def finalize(data):
    return finalize_vo2_metrics(data)
