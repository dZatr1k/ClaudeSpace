"""Listening ports (BACKLOG 10): /proc/net/tcp{,6} parsing on fixture text, process names, a real scan of a server
started in a fake project, and the ports_changed event."""
import os
import socket
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from cclib import netstat  # noqa: E402
from tests import fixtures as fx  # noqa: E402

TCP = """  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3401234 1 0 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22222 1 0 100 0 0 10 0
   2: 0100007F:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0 100 0 0 10 0
   3: 0100007F:1F90 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 0 1 0 20 4 30 10 -1
   4: 0F02000A:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0 100 0 0 10 0
garbage line
"""
TCP6 = """  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9001 1 0 100 0 0 10 0
   1: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22223 1 0 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:2382 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9002 1 0 100 0 0 10 0
"""


class ParseTest(unittest.TestCase):
    def test_tcp4(self):
        rows = netstat.parse_tcp(TCP)
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[0], {'addr': '127.0.0.1', 'port': 8080, 'state': '0A', 'uid': 1000, 'inode': 3401234})
        self.assertEqual((rows[1]['addr'], rows[1]['port'], rows[1]['uid']), ('0.0.0.0', 22, 0))
        self.assertEqual(rows[2]['port'], 2222)
        self.assertEqual(rows[3]['state'], '01')                 # established, not a listener
        self.assertEqual(rows[4]['addr'], '10.0.2.15')

    def test_tcp6(self):
        rows = netstat.parse_tcp(TCP6, v6=True)
        self.assertEqual((rows[0]['addr'], rows[0]['port']), ('::1', 5173))
        self.assertEqual((rows[1]['addr'], rows[1]['port']), ('::', 22))
        self.assertEqual((rows[2]['addr'], rows[2]['port']), ('::ffff:127.0.0.1', 9090))

    def test_display_name(self):
        dn = netstat.display_name
        self.assertEqual(dn('node', ['node', '/home/u/p/node_modules/vite/bin/vite.js', '--port', '4173']), 'vite')
        self.assertEqual(dn('node', ['node', '/home/u/p/node_modules/.bin/next', 'dev']), 'next')
        self.assertEqual(dn('node', ['node', '/x/node_modules/@angular/cli/bin/ng.js']), '@angular/cli')
        self.assertEqual(dn('python3', ['python3', '-m', 'http.server', '8000']), 'http.server')
        self.assertEqual(dn('python3', ['/usr/bin/python3', '-u', 'site/serve.py']), 'serve')
        self.assertEqual(dn('postgres', ['postgres', '-D', '/x']), 'postgres')
        self.assertEqual(dn('node', []), 'node')


class ScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fh = fx.FakeHome()
        # a dev server in a project folder of the fake HOME
        cls.srv = subprocess.Popen([sys.executable, '-u', '-m', 'http.server', '0', '--bind', '127.0.0.1'],
                                   cwd=cls.fh.alpha, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = cls.srv.stdout.readline()          # "Serving HTTP on 127.0.0.1 port 41234 (http://…) ..."
        cls.port = int(line.split(' port ')[1].split()[0])

    @classmethod
    def tearDownClass(cls):
        cls.srv.kill()
        cls.srv.wait()
        cls.fh.cleanup()

    def test_scan_finds_project_server(self):
        sc = netstat.PortScanner(self.fh.home, skip_ports=(2222,))
        ports = {p['port']: p for p in sc.scan()}
        p = ports.get(self.port)
        self.assertIsNotNone(p, ports)
        self.assertEqual(p['pid'], self.srv.pid)
        self.assertEqual(p['name'], 'http.server')
        self.assertEqual((p['project'], p['projectPath']), ('Alpha', self.fh.alpha))
        self.assertEqual(p['addr'], '127.0.0.1')
        for x in ports.values():
            self.assertNotEqual(x['port'], 2222)
        self.assertNotIn(self.port, [x['port'] for x in netstat.PortScanner(self.fh.home, (self.port,)).scan()])

    def test_event_on_new_and_closed_port(self):
        ag = fx.AgentProc(self.fh)
        try:
            first, n = ag.wait_event('ports_changed')
            self.assertIn(self.port, [x['port'] for x in first['ports']])
            s = socket.socket()
            s.bind(('127.0.0.1', 0))
            s.listen(1)
            extra = s.getsockname()[1]
            d, n = ag.wait_event('ports_changed', lambda d: extra in [x['port'] for x in d['ports']], 10, n)
            self.assertIsNone(next(x for x in d['ports'] if x['port'] == extra)['project'])  # test runner cwd
            s.close()
            ag.wait_event('ports_changed', lambda d: extra not in [x['port'] for x in d['ports']], 10, n)
            r = ag.call('list_ports')['result']
            self.assertIn(self.port, [x['port'] for x in r['ports']])
        finally:
            ag.close()


if __name__ == '__main__':
    unittest.main()
