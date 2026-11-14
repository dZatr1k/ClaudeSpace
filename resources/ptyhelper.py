#!/usr/bin/env python3
"""PTY helper for ClaudeSpace's local transport (dev on the VM, tests). stdlib only.

  python3 -I ptyhelper.py ROWS COLS CMD [ARGS...]

stdin -> pty, pty -> stdout. fd 3: control lines "ROWS COLS\\n" -> TIOCSWINSZ (+SIGWINCH via the kernel).
Exits with the child's exit code when the child exits.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    rows, cols, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        try:
            set_size(0, rows, cols)
        except OSError:
            pass
        os.execvp(argv[0], argv)
    set_size(master, rows, cols)
    ctl = 3
    try:
        os.fstat(ctl)
    except OSError:
        ctl = None
    signal.signal(signal.SIGHUP, lambda *a: (os.kill(pid, signal.SIGHUP), None))
    fds = [0, master] + ([ctl] if ctl is not None else [])
    ctl_buf = b''
    status = None
    while True:
        try:
            r, _, _ = select.select(fds, [], [], 0.5)
        except InterruptedError:
            continue
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                break
            os.write(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                fds.remove(0)
            else:
                os.write(master, data)
        if ctl is not None and ctl in r:
            data = os.read(ctl, 4096)
            if not data:
                fds.remove(ctl)
            else:
                ctl_buf += data
                while b'\n' in ctl_buf:
                    line, ctl_buf = ctl_buf.split(b'\n', 1)
                    try:
                        rr, cc = (int(x) for x in line.split())
                        set_size(master, rr, cc)
                        os.kill(pid, signal.SIGWINCH)
                    except (ValueError, OSError):
                        pass
        wpid, st = os.waitpid(pid, os.WNOHANG)
        if wpid:
            status = st
            # drain what is left
            while True:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(1, data)
            break
    if status is None:
        _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else status >> 8)


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        sys.exit(1)
