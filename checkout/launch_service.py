#!/usr/bin/env python3
"""PM2 launcher: read restricted local JSON and two merchant keys, then exec.

The parent PM2 process receives no secrets. Never use shell source or log values.
This is a deployment template; it does not run or install services by itself.
"""
import json
import os
import shlex
import stat
import sys
from pathlib import Path

CONFIG_ROOT = Path('/root/nodelete_robot/checkout-config')
MERCHANT_ENV = Path('/root/anonpay2/.env')
ALLOWED = {
    'checkout': {'GHOST_CHECKOUT_PUBLIC_URL', 'GHOST_CHECKOUT_DATABASE', 'GHOST_CHECKOUT_INTERNAL_SECRET', 'GHOST_EVENT_SECRET', 'GHOST_EVENT_URL', 'GHOST_SELLER_NAME', 'GHOST_SELLER_INN', 'GHOST_SELLER_REGISTRATION', 'GHOST_SELLER_EMAIL', 'GHOST_SUPPORT_URL', 'GHOST_OFFER_URL', 'GHOST_PRIVACY_URL', 'GHOST_TERMS_VERSION', 'GHOST_RECEIPT_TAXATION', 'GHOST_RECEIPT_VAT', 'GHOST_RECEIPT_LABEL', 'GHOST_CHECKOUT_PORT', 'GHOST_PROVIDER_TOKENIZATION_VERIFIED', 'GHOST_PROVIDER_RECEIPTS_VERIFIED', 'GHOST_PROVIDER_UNVERIFIED_DEPLOYMENT_ACKNOWLEDGED'},
    'router': {'GHOST_CHECKOUT_DATABASE', 'GHOST_CALLBACK_ROUTER_PORT'},
}


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, encoding='utf-8') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError('configuration file must be root-owned and private')
        return source.read()


def merchant_credentials():
    values = {}
    for line in read_private(MERCHANT_ENV).splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, raw = line.split('=', 1)
        if key not in ('CP_PUBLIC_ID', 'CP_API_SECRET'):
            continue
        if key in values:
            raise ValueError('duplicate merchant key')
        tokens = shlex.split(raw, comments=True, posix=True)
        if len(tokens) != 1:
            raise ValueError('unsupported merchant key format')
        values[key] = tokens[0]
    if set(values) != {'CP_PUBLIC_ID', 'CP_API_SECRET'} or not all(values.values()):
        raise ValueError('merchant credentials unavailable')
    return {'CLOUDPAYMENTS_PUBLIC_ID': values['CP_PUBLIC_ID'], 'CLOUDPAYMENTS_API_SECRET': values['CP_API_SECRET']}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ALLOWED or os.geteuid() != 0:
        raise ValueError('usage: launch_service.py checkout|router RELEASE_DIRECTORY (as root)')
    mode = sys.argv[1]
    releases = Path('/root/nodelete_robot/checkout-releases').resolve()
    release = Path(sys.argv[2]).resolve(strict=True)
    if release.parent != releases:
        raise ValueError('release directory must be a direct child of checkout-releases')
    config = json.loads(read_private(CONFIG_ROOT / f'{mode}.json'))
    if not isinstance(config, dict) or set(config) != ALLOWED[mode] or any(not isinstance(v, str) or not v for v in config.values()):
        raise ValueError('invalid service configuration: verify required fields')
    expected_database = '/root/nodelete_robot/checkout-data/payments.sqlite3'
    if config['GHOST_CHECKOUT_DATABASE'] != expected_database:
        raise ValueError('invalid isolated database path')
    if mode == 'checkout' and config['GHOST_CHECKOUT_PORT'] != '8093':
        raise ValueError('invalid checkout port')
    if mode == 'router' and config['GHOST_CALLBACK_ROUTER_PORT'] != '8096':
        raise ValueError('invalid router port')
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONUNBUFFERED': '1', **config, **merchant_credentials()}
    executable = str(release / 'venv/bin/python')
    script = str(release / ('checkout/app.py' if mode == 'checkout' else 'checkout/callback_router.py'))
    os.execve(executable, [executable, script], env)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError):
        # Exceptions may contain secret input. Deliberately never print them.
        print('Ghost service launch failed: check private configuration and release.', file=sys.stderr)
        raise SystemExit(1)
