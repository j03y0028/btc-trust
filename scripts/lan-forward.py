#!/usr/bin/env python3
"""Tiny TCP forwarder: expose the myNode simulation (127.0.0.1:19330) on a LAN IP so a browser sees a
non-localhost, plain-HTTP origin (an insecure context, like http://192.168.1.119 on a real myNode).
  python3 scripts/lan-forward.py <listen_ip> <listen_port> [target_port]"""
import asyncio, sys

LISTEN_IP, LISTEN_PORT = sys.argv[1], int(sys.argv[2])
TARGET = ('127.0.0.1', int(sys.argv[3]) if len(sys.argv) > 3 else 19330)

async def pipe(r, w):
    try:
        while data := await r.read(65536):
            w.write(data); await w.drain()
    finally:
        w.close()

async def handle(cr, cw):
    sr, sw = await asyncio.open_connection(*TARGET)
    await asyncio.gather(pipe(cr, sw), pipe(sr, cw), return_exceptions=True)

async def main():
    srv = await asyncio.start_server(handle, LISTEN_IP, LISTEN_PORT)
    print(f'forwarding http://{LISTEN_IP}:{LISTEN_PORT} -> {TARGET[0]}:{TARGET[1]}', flush=True)
    async with srv: await srv.serve_forever()

asyncio.run(main())
