"""Ver- und Entschlüsselung: Datenpaket (Format gesundheit-v1) und Token-Zustand."""
import base64, json, secrets
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 600_000
AAD_DATA = b'gesundheit-v1'
AAD_STATE = b'gesundheit-export-token-v1'
_b64 = lambda x: base64.b64encode(x).decode('ascii')


def _key(secret, salt, iterations=ITERATIONS):
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(secret.encode('utf-8'))


def open_package(envelope, password):
    """Entschlüsselt das Datenpaket. Gibt (Daten, Schlüssel) zurück; der Schlüssel dient dem Neuverschlüsseln mit gleichem Salt."""
    if envelope.get('format') != 'gesundheit-v1' or envelope.get('iterations') != ITERATIONS:
        raise ValueError('envelope')
    key = _key(password, base64.b64decode(envelope['salt']), envelope['iterations'])
    raw = AESGCM(key).decrypt(base64.b64decode(envelope['iv']), base64.b64decode(envelope['ciphertext']), AAD_DATA)
    return json.loads(raw), key


def seal_package(data, key, salt_b64):
    """Gleiches Salt (gemerkte Gerätezugänge bleiben gültig), jedes Mal ein neuer IV."""
    iv = secrets.token_bytes(12)
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return {'format': 'gesundheit-v1', 'algorithm': 'AES-GCM-256', 'kdf': 'PBKDF2-SHA256', 'iterations': ITERATIONS,
            'salt': salt_b64, 'iv': _b64(iv), 'ciphertext': _b64(AESGCM(key).encrypt(iv, payload, AAD_DATA))}


def open_state(envelope, state_key):
    key = _key(state_key, base64.b64decode(envelope['salt']))
    return json.loads(AESGCM(key).decrypt(base64.b64decode(envelope['iv']), base64.b64decode(envelope['ciphertext']), AAD_STATE))


def seal_state(state, state_key):
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    ct = AESGCM(_key(state_key, salt)).encrypt(iv, json.dumps(state).encode('utf-8'), AAD_STATE)
    return {'format': 'gesundheit-export-token-v1', 'salt': _b64(salt), 'iv': _b64(iv), 'ciphertext': _b64(ct)}
