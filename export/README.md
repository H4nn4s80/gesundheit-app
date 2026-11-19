# Daten-Export

Aktualisiert `data.enc.json` alle 4 Stunden über GitHub Actions (`.github/workflows/daten-export.yml`).

Ablauf eines Laufs (`update.py`):

1. Aktuelles Datenpaket mit dem App-Passwort öffnen.
2. Garmin (letzte 2 Tage, nachts 7 Tage) und Withings (7 Tage) nur lesend abrufen.
3. Neue Werte einmischen. Aktivitäten der letzten 7 Tage werden durch den aktuellen Garmin-Stand ersetzt, in Connect gelöschte Einheiten verschwinden also.
4. Prüfen, dass keine Kennzahlen oder Messpunkte verloren gehen; sonst Abbruch ohne Veröffentlichung.
5. Mit gleichem Salt und neuem IV verschlüsseln und committen, wenn sich Daten geändert haben.

Die Zugangstoken beider Anbieter erneuern sich bei der Nutzung. Ihr aktueller Stand liegt verschlüsselt in `state/token.enc.json` (AES-GCM, Schlüssel aus dem Secret `STATE_KEY`).

## Secrets

| Name | Inhalt |
|---|---|
| `HEALTH_APP_PASSWORD` | Passwort der App |
| `STATE_KEY` | langer Zufallswert (mindestens 32 Zeichen), schützt die Token-Datei |
| `ZUGANGSDATEN` | die Übergabedatei als Ganzes (JSON mit `garmin_tokens_json`, `withings_client_id`, `withings_client_secret`, `withings_refresh_token`) |

Garmin- und Withings-Refresh-Token aus `ZUGANGSDATEN` werden nur beim ersten Lauf gelesen; danach gilt der Stand in `state/token.enc.json`. Nach dem Erneuern von `ZUGANGSDATEN` den Workflow einmal von Hand mit „Zugangstoken neu aus den Secrets lesen“ starten.

Das Protokoll enthält pro Lauf nur eine Statuszeile ohne Messwerte. `extend_export.py`, `vo2_attribution.py` und `canonical_data.py` stammen unverändert aus dem bisherigen Export.

## Withings-Fehlerdiagnose

HTTP-Status und Withings-API-Status werden getrennt protokolliert. Ein API-Status `503` bei HTTP `200` ist nicht dasselbe wie HTTP `503`. Rohantworten, Token und Messwerte werden nie protokolliert. Explizite HTTP-Fehler 502/503/504 werden höchstens zweimal mit Pause wiederholt. Authentifizierungsfehler, Sperren (403/429) und Transport-Timeouts werden nicht automatisch wiederholt. Bei einem Timeout könnte ein Refresh-Token bereits rotiert sein.

Tests ohne echte Zugangsdaten: `python -m unittest discover -s export/tests -v`.

## Nur Withings erneut autorisieren

Bei `invalid_refresh_token` muss dieselbe Withings-App erneut autorisiert werden. Einen frisch erteilten Refresh-Token ausschließlich als GitHub Actions Secret `WITHINGS_REFRESH_TOKEN` speichern, niemals in Workflow-Eingaben, Chat, Commit oder Log. Client-ID und Client-Secret müssen zur autorisierten App gehören.

Danach `Daten-Export` auf `main` manuell mit `withings_erneuern: true` und `neu_einrichten: false` ausführen. Der bestehende verschlüsselte Garmin-Zustand bleibt erhalten; Garmin darf seine Token im normalen Abruf erneuern. Die Withings-Erneuerung setzt einen vorhandenen entschlüsselbaren Zustand und das dedizierte Secret voraus und lehnt gleichzeitiges vollständiges Bootstrap ab. Abgelehnte Ersatztoken überschreiben den bisherigen Zustand nicht. Nach erfolgreicher Token-Rotation wird der neue Token verschlüsselt gesichert.

Diese Vorbereitung erstellt keine OAuth-Autorisierung und ersetzt keine Benutzerzustimmung bei Withings.
