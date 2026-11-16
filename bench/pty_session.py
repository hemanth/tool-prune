#!/usr/bin/env python3
"""Run one interactive program inside a pseudo-terminal and stop when it is done.

Claude Code's experimental Code Mode only starts in the interactive terminal
(`claude -p` falls back to the ordinary tools), so the benchmark has to drive a
real TUI session. This helper owns the pty; the Node harness owns everything else.

Usage:
  pty_session.py --done-file <transcript.jsonl> [--timeout 150] [--screen out.txt]
                 [--keys '[[seconds, "text"], ...]'] -- <command> [args...]

Exits 0 when the transcript contains a finished turn, 2 on timeout, 3 if the
program exited before finishing a turn. Zero dependencies (stdlib only).
"""
import argparse
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

DONE_MARK = b'"subtype":"turn_duration"'


def main():
    argv = sys.argv[1:]
    if '--' not in argv:
        sys.exit('usage: pty_session.py [options] -- command...')
    split = argv.index('--')
    cmd = argv[split + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument('--done-file', required=True)
    ap.add_argument('--timeout', type=float, default=150)
    ap.add_argument('--screen', default='')
    ap.add_argument('--keys', default='[]')
    args = ap.parse_args(argv[:split])
    keys = sorted(json.loads(args.keys))

    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 180, 0, 0))

    t0 = time.time()
    buf = bytearray()
    status = 2
    last_poll = 0.0
    while time.time() - t0 < args.timeout:
        try:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                data = os.read(fd, 65536)
                if not data:
                    status = 3
                    break
                buf += data
                if b'\x1b[6n' in data:  # cursor position query
                    os.write(fd, b'\x1b[1;1R')
        except OSError:
            status = 3
            break
        now = time.time()
        while keys and now - t0 >= keys[0][0]:
            os.write(fd, keys.pop(0)[1].encode())
        if now - last_poll > 0.5:
            last_poll = now
            try:
                with open(args.done_file, 'rb') as fh:
                    if DONE_MARK in fh.read().replace(b'": "', b'":"'):
                        status = 0
                        break
            except FileNotFoundError:
                pass

    # Let the program flush its session records, then stop it.
    try:
        os.kill(pid, signal.SIGTERM)
        deadline = time.time() + 4
        while time.time() < deadline:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                break
            try:
                if select.select([fd], [], [], 0.1)[0]:
                    buf += os.read(fd, 65536)
            except OSError:
                pass
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass

    if args.screen:
        text = buf.decode('utf8', 'replace')
        text = re.sub(r'\x1b\[(\d+)C', lambda m: ' ' * int(m.group(1)), text)
        text = re.sub(r'\x1b\[\d+;\d+H', '\n', text)
        text = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', text)
        text = re.sub(r'\x1b\[[0-9;?<>=]*[a-zA-Z]', '', text)
        text = re.sub(r'\x1b[()][0-9A-B]|\x1b[=>78]', '', text)
        with open(args.screen, 'w') as fh:
            fh.write(text.replace('\r', '\n'))
    sys.exit(status)


if __name__ == '__main__':
    main()
