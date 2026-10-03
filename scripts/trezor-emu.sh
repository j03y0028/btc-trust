#!/usr/bin/env bash
# Trezor Model T EMULATOR (headless) for HWI development. REGTEST/TESTING ONLY.
# Loads the public Trezor test mnemonic "all all ... all" (12x) — never use for real funds.
set -euo pipefail
EMU_DIR=${TREZOR_EMU_DIR:-/workspace/trezor-emu}
EMU_BIN=${TREZOR_EMU_BIN:-$EMU_DIR/trezor-emu-core-v2.7.0}
HWI=${HWI_PATH:-/workspace/hwi/hwi}
running() { ss -uln 2>/dev/null | grep -q '127.0.0.1:21324'; }
case "${1:-start}" in
  start)
    if running; then echo "emulator already running"; else
      mkdir -p "$EMU_DIR/profile"
      SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy TREZOR_PROFILE_DIR="$EMU_DIR/profile" nohup "$EMU_BIN" > "$EMU_DIR/emu.log" 2>&1 &
      for _ in $(seq 30); do running && break; sleep 0.5; done
      sleep 2
    fi
    "$EMU_DIR/venv/bin/python" "$(dirname "$0")/trezor-load-seed.py"
    "$HWI" --emulators --chain regtest enumerate;;
  stop) pkill -f trezor-emu-core || true;;
  status) "$HWI" --emulators --chain regtest enumerate;;
  *) echo "usage: $0 start|stop|status"; exit 1;;
esac
