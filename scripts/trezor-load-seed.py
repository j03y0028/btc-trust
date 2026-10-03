# Load the public Trezor TEST mnemonic ("all all ...") into the EMULATOR via DebugLink. Regtest/testing only.
from trezorlib import debuglink, device
from trezorlib.debuglink import TrezorClientDebugLink
from trezorlib.transport.udp import UdpTransport

t = UdpTransport("127.0.0.1:21324")
client = TrezorClientDebugLink(t, auto_interact=True)
if client.features.initialized:
    print("already initialized:", client.features.label)
else:
    debuglink.load_device(client, mnemonic=" ".join(["all"] * 12), pin="", passphrase_protection=False, label="BTC Trust Emu")
    print("loaded")
client.close()
