"""VO₂max aus Garmin max_metrics ehrlich zuordnen.

Feld „generic“ ist kein bestätigtes Lauf-VO₂max. Es darf nur als
vo2run erscheinen, wenn an dem Kalendertag eine Laufeinheit liegt.
Feld „rowing“ bleibt vo2row; ein erster Wert, der mit generic am
selben (Nicht-Ruder-)Tag übereinstimmt, gilt als unsicher und gehört
nicht in den Verlauf.

Keine Anbieterzugriffe, keine Tokens.
"""
from __future__ import annotations

RUN_KEYS = frozenset({
    'running', 'trail_running', 'track_running', 'treadmill_running',
})
ROW_KEYS = frozenset({'indoor_rowing', 'rowing'})

RUN_NOTE = 'Zuordnung über Laufeinheit an diesem Tag.'
ROW_OK_NOTE = 'Zuordnung über Ruder-Einheit an diesem Tag.'
UNCERTAIN_REASON = (
    'Unsicherer erster Wert: am selben Tag steht derselbe Wert als '
    'allgemeines VO₂max, ohne bestätigte Ruder-Einheit. '
    'Fließt nicht in den Verlauf ein.'
)
DROPPED_MULTI = (
    'Kein Lauf-VO₂max: an diesem Tag lag keine Laufeinheit vor'
    ' (Multisport). Der Wert wird nicht als Laufen geführt.'
)
DROPPED_OTHER = (
    'Kein Lauf-VO₂max: an diesem Tag lag keine Laufeinheit vor. '
    'Der allgemeine Wert wird nicht als Laufen geführt.'
)

def sport_key(act: dict) -> str:
    if not isinstance(act, dict):
        return ''
    return str(act.get('sportKey') or '')

def is_run_key(key: str) -> bool:
    k = (key or '').lower()
    if k in RUN_KEYS:
        return True
    return 'running' in k and 'e_bike' not in k

def is_row_key(key: str) -> bool:
    return (key or '').lower() in ROW_KEYS

def activities_by_date(activities) -> dict:
    by = {}
    for a in activities or []:
        if not isinstance(a, dict):
            continue
        day = a.get('date')
        if not day and a.get('startTimeLocal'):
            day = str(a['startTimeLocal'])[:10]
        if not day:
            continue
        by.setdefault(day, []).append(a)
    return by

def day_has_run(day: str, by_date: dict) -> bool:
    return any(is_run_key(sport_key(a)) for a in by_date.get(day, []))

def day_has_row(day: str, by_date: dict) -> bool:
    return any(is_row_key(sport_key(a)) for a in by_date.get(day, []))

def is_uncertain_rowing(day: str, value, by_date: dict, generic_by_day: dict) -> bool:
    if day_has_row(day, by_date):
        return False
    gen = generic_by_day.get(day)
    if gen is None or value is None:
        return False
    try:
        return abs(float(gen) - float(value)) < 0.15
    except (TypeError, ValueError):
        return False

def dropped_reason(day: str, by_date: dict) -> str:
    keys = {sport_key(a) for a in by_date.get(day, [])}
    if 'multi_sport' in keys:
        return DROPPED_MULTI
    return DROPPED_OTHER

def _metric(data: dict, mid: str):
    for m in data.get('metrics') or []:
        if m.get('id') == mid:
            return m
    return None

def finalize_vo2_metrics(data: dict) -> dict:
    """Bereinigt vo2run/vo2row in einem bereits gebauten data-Objekt. Idempotent."""
    if not isinstance(data, dict):
        return data
    by_date = activities_by_date(data.get('activities') or [])
    run_m = _metric(data, 'vo2run')
    row_m = _metric(data, 'vo2row')
    if not run_m and not row_m:
        return data

    generic_all = list((run_m or {}).get('points') or [])
    row_all = list((row_m or {}).get('points') or [])
    # Already-omitted points stay omitted if we run twice.
    prev_omitted_run = list((run_m or {}).get('omitted') or [])
    prev_omitted_row = list((row_m or {}).get('omitted') or [])
    generic_by_day = {p['date']: p.get('value') for p in generic_all if p.get('date')}
    for p in prev_omitted_run:
        if p.get('date') and p.get('date') not in generic_by_day:
            generic_by_day[p['date']] = p.get('value')

    kept_run, omitted_run = [], []
    seen = set()
    for p in generic_all:
        day = p.get('date')
        if not day or day in seen:
            continue
        seen.add(day)
        if day_has_run(day, by_date):
            q = dict(p)
            q['note'] = RUN_NOTE
            q.pop('uncertain', None)
            kept_run.append(q)
        else:
            q = dict(p)
            q['reason'] = dropped_reason(day, by_date)
            omitted_run.append(q)
    # keep previous omissions that are no longer in points
    for p in prev_omitted_run:
        if p.get('date') not in seen:
            omitted_run.append(p)

    kept_row, omitted_row = [], []
    seen_r = set()
    for p in row_all:
        day = p.get('date')
        if not day or day in seen_r:
            continue
        seen_r.add(day)
        if is_uncertain_rowing(day, p.get('value'), by_date, generic_by_day):
            q = dict(p)
            q['uncertain'] = True
            q['reason'] = UNCERTAIN_REASON
            omitted_row.append(q)
        else:
            q = dict(p)
            q.pop('uncertain', None)
            if day_has_row(day, by_date) and not q.get('note'):
                q['note'] = ROW_OK_NOTE
            kept_row.append(q)
    for p in prev_omitted_row:
        if p.get('date') not in seen_r:
            omitted_row.append(p)

    if run_m is not None:
        run_m['name'] = 'VO₂max · Laufen / allgemein'
        run_m['points'] = sorted(kept_run, key=lambda x: x['date'])
        if omitted_run:
            run_m['omitted'] = sorted(omitted_run, key=lambda x: x.get('date') or '')
        else:
            run_m.pop('omitted', None)
    if row_m is not None:
        row_m['name'] = 'VO₂max · Rudern'
        row_m['points'] = sorted(kept_row, key=lambda x: x['date'])
        if omitted_row:
            row_m['omitted'] = sorted(omitted_row, key=lambda x: x.get('date') or '')
        else:
            row_m.pop('omitted', None)

    notes = data.setdefault('notes', [])
    msg = (
        'VO₂max Laufen/allgemein nur an Tagen mit einer Laufeinheit. '
        'Allgemeine Garmin-Werte ohne Lauf (zum Beispiel Multisport) werden nicht als Lauf-VO₂max gezeigt. '
        'Der erste Rudern-Wert wird weggelassen, wenn er unsicher mit dem allgemeinen Wert zusammenfällt.'
    )
    notes[:] = [n for n in notes if 'VO₂max allgemein ist nicht eindeutig' not in n and 'VO₂max Laufen/allgemein nur an Tagen' not in n]
    notes.append(msg)
    return data
