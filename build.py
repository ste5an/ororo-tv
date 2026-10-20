#!/usr/bin/env python3
"""Builds Ororo TV for Samsung TVs (Tizen) and, optionally, installs it.

    python3 build.py                                  # → OroroTV.wgt, not signed
    python3 build.py --sign freemytv                  # signed with a Tizen security profile
    python3 build.py --sign freemytv --install 192.168.1.70   # … and installed and opened on the TV

credentials.properties (optional, never committed) puts your Ororo email and password into the app, so the TV
skips the sign-in screen:  email=you@example.com  /  password=...
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.join(ROOT, 'www')
OUT = os.path.join(ROOT, 'out')
WGT = os.path.join(ROOT, 'OroroTV.wgt')
APP_ID = 'OroroTVapp.OroroTV'


def tool(name):
    """Samsung's `tizen` or `sdb`, from Tizen Studio's usual places or the PATH."""
    rel = {'tizen': os.path.join('tools', 'ide', 'bin', 'tizen'), 'sdb': os.path.join('tools', 'sdb')}[name]
    for base in (os.environ.get('TIZEN_STUDIO', ''), os.path.expanduser('~/tizen-studio')):
        if base and os.path.exists(os.path.join(base, rel)):
            return os.path.join(base, rel)
    found = shutil.which(name)
    if not found:
        sys.exit('Samsung\'s `%s` not found: install Tizen Studio\'s CLI or set TIZEN_STUDIO.' % name)
    return found


def read_props(path):
    props = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    props[k.strip()] = v.strip()
    return props


def build():
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(WWW, OUT)
    shutil.copy(os.path.join(ROOT, 'config.xml'), OUT)
    props = read_props(os.path.join(ROOT, 'credentials.properties'))
    user, password = props.get('email', ''), props.get('password', '')
    creds = json.dumps({'user': user, 'pass': password}) if user and password else 'null'
    with open(os.path.join(OUT, 'creds.js'), 'w', encoding='utf-8') as f:
        f.write('window.ORORO_CREDENTIALS = %s;\n' % creds)
    if os.path.exists(WGT):
        os.remove(WGT)
    with zipfile.ZipFile(WGT, 'w', zipfile.ZIP_DEFLATED) as z:
        for folder, _, files in os.walk(OUT):
            for name in sorted(files):
                path = os.path.join(folder, name)
                z.write(path, os.path.relpath(path, OUT))
    return bool(user and password)


def sign(profile):
    out = tempfile.mkdtemp()
    try:
        run = subprocess.run([tool('tizen'), 'package', '-t', 'wgt', '-s', profile, '-o', out, '--', WGT],
                             capture_output=True, text=True)
        made = [n for n in os.listdir(out) if n.endswith('.wgt')]
        if run.returncode != 0 or not made:
            sys.exit('`tizen package` didn\'t sign it:\n' + (run.stdout + run.stderr).strip())
        shutil.move(os.path.join(out, made[0]), WGT)
    finally:
        shutil.rmtree(out, ignore_errors=True)


def install(ip):
    sdb, tizen = tool('sdb'), tool('tizen')
    subprocess.run([sdb, 'connect', ip], capture_output=True, text=True)
    devices = subprocess.run([sdb, 'devices'], capture_output=True, text=True).stdout.splitlines()[1:]
    targets = [p[2] for p in (line.split() for line in devices) if len(p) >= 3 and p[0].startswith(ip) and p[1] == 'device']
    if not targets:
        sys.exit('The TV at %s isn\'t connected: is Developer Mode on, with this computer\'s IP as Host PC IP?' % ip)
    for cmd in (['install', '-n', os.path.basename(WGT), '-t', targets[0]], ['run', '-p', APP_ID, '-t', targets[0]]):
        run = subprocess.run([tizen] + cmd, cwd=ROOT, capture_output=True, text=True)
        text = run.stdout + run.stderr
        if run.returncode != 0 or 'error' in text.lower() and 'success' not in text.lower():
            sys.exit('`tizen %s` failed:\n%s' % (cmd[0], text.strip()))
    print('Installed and opened on %s.' % targets[0])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--sign', metavar='PROFILE', help='Tizen security profile to sign with')
    ap.add_argument('--install', metavar='TV_IP', help='install on the TV at this address (needs --sign)')
    args = ap.parse_args()
    if args.install and not args.sign:
        sys.exit('TVs only install signed apps: add --sign PROFILE.')
    with_creds = build()
    if args.sign:
        sign(args.sign)
    print('Built %s (%d KB, %s, %s)' % (os.path.basename(WGT), os.path.getsize(WGT) // 1024,
                                       'signed with "%s"' % args.sign if args.sign else 'not signed',
                                       'with your Ororo account' if with_creds else 'sign in on the TV'))
    if args.install:
        install(args.install)


if __name__ == '__main__':
    main()
