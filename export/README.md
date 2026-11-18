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
