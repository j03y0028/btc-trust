// Stage 8: end-to-end checks against the simulated myNode started by scripts/mynode-sim.sh up.
//   backend/node_modules/.bin/tsx scripts/verify-mynode-sim.mts
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { ReadOnlyRpc, ReadOnlyViolation } from '../backend/src/readonly-rpc.ts';
import { BitcoinRpc } from '../backend/src/rpc.ts';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const WS = require('ws');
const SIM = process.env.SIM ?? '/tmp/mynode-sim';
const URL0 = process.env.APP_URL ?? 'http://127.0.0.1:19330';
const NAME = 'btctrust-sim';
const DATA = `${SIM}/mnt/hdd/mynode/btctrust`;
const env = Object.fromEntries(readFileSync(`${DATA}/btctrust.env`, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const MYNODE_PW = readFileSync(`${SIM}/mnt/hdd/mynode/settings/.btcrpcpw`, 'utf8').trim();
const RPCPORT = 18643;
const PASS = process.env.APP_PASSPHRASE ?? 'correct horse battery staple mynode';

let pass = 0, fail = 0;
const results: string[] = [];
const ok = (cond: unknown, what: string, extra = '') => { (cond ? pass++ : fail++); const l = `${cond ? 'PASS' : 'FAIL'}  ${what}${extra ? `  (${extra})` : ''}`; results.push(l); console.log(l); };
const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
let direct: boolean | undefined;
const docker = (...a: string[]) => {
  if (direct === undefined) { try { execFileSync('docker', ['info'], { stdio: 'ignore' }); direct = true; } catch { direct = false; } }
  return direct ? execFileSync('docker', a, { encoding: 'utf8' }) : execFileSync('sg', ['docker', '-c', ['docker', ...a].map(q).join(' ')], { encoding: 'utf8' });
};

let cookie = '';
const api = async (p: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) };
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(init.json); }
  const r = await fetch(URL0 + p, { ...init, headers });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let body: any = t; try { body = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, body, headers: r.headers };
};

// 1. login
ok((await api('/api/healthz')).status === 200, 'healthz is public');
ok((await api('/api/stages')).status === 401, 'API requires login (GET /api/stages -> 401)');
ok((await api('/')).status === 200, 'SPA served from the backend on the same port');
const st = (await api('/api/auth/status')).body;
ok(st.required && !st.configured && st.setupTokenRequired, 'first run: setup token required', JSON.stringify(st));
ok((await api('/api/auth/setup', { method: 'POST', json: { passphrase: PASS, setupToken: 'wrong-token-xxxxxxxx' } })).status >= 400, 'setup with wrong token refused');
const token = readFileSync(`${DATA}/app/setup-token`, 'utf8').trim();
const setup = await api('/api/auth/setup', { method: 'POST', json: { passphrase: PASS, setupToken: token } });
ok(setup.status === 201 && cookie.startsWith('btctrust_sid='), 'setup with token from the myNode data dir -> session cookie');
ok(/HttpOnly/i.test(setup.headers.get('set-cookie') ?? '') && /SameSite=Lax/i.test(setup.headers.get('set-cookie') ?? ''), 'cookie is HttpOnly + SameSite=Lax');
ok((await api('/api/auth/setup', { method: 'POST', json: { passphrase: PASS, setupToken: token } })).status >= 400, 'setup cannot be repeated');
const authFile = JSON.parse(readFileSync(`${DATA}/app/auth.json`, 'utf8'));
ok(JSON.stringify(authFile).includes('scrypt') && !JSON.stringify(authFile).includes(PASS), 'auth.json stores a scrypt hash, not the passphrase');
const saved = cookie; cookie = '';
ok((await api('/api/auth/login', { method: 'POST', json: { passphrase: 'nope nope nope nope' } })).status === 401, 'wrong passphrase -> 401');
ok((await api('/api/auth/login', { method: 'POST', json: { passphrase: PASS } })).status === 200, 'login with passphrase');
cookie = saved;
// fetch() drops a custom Host header, so use curl
const hostCode = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Host: evil.example', '-H', `cookie: ${cookie}`, `${URL0}/api/stages`], { encoding: 'utf8' });
ok(hostCode === '421', 'foreign Host header refused with 421 (DNS rebinding)', hostCode);

// 2. split mode
const mode = (await api('/api/mode')).body;
ok(mode.mode === 'split' && mode.mainnet.readOnly && mode.wallet.enabled && mode.wallet.network === 'regtest', 'mode = split, mainnet read-only, wallets on regtest', JSON.stringify({ mode: mode.mode, wallet: mode.wallet, methods: mode.mainnet.methods.length }));
const mcli = (...a: string[]) => execFileSync('bitcoin-cli', ['-regtest', `-datadir=${SIM}/mnt/hdd/mynode/bitcoin`, `-rpcport=${RPCPORT}`, '-rpcuser=mynode', `-rpcpassword=${MYNODE_PW}`, ...a], { encoding: 'utf8' }).trim();
const standIn = Number(mcli('getblockcount'));
const main = (await api('/api/blockchain?source=mainnet')).body;
const mainHeight = main.blocks ?? main.height;
ok(mainHeight === standIn, 'dashboard (?source=mainnet) shows the myNode stand-in height', `${mainHeight} vs node ${standIn}`);
const blocks = (await api('/api/blocks?count=5&source=mainnet')).body;
ok(Array.isArray(blocks) && blocks.length === 5 && blocks[0].hash === mcli('getbestblockhash'), 'recent blocks come from the myNode node');

// 3. wallet features on the separate test node
const w = await api('/api/wallets', { method: 'POST', json: { name: 'Sim Trust', type: 'multisig', m: 2, n: 3 } });
ok(w.status === 201 || w.status === 200, 'create 2-of-3 wallet', String(w.status));
const wid = w.body.id ?? w.body.wallet?.id;
const mine = await api('/api/regtest/mine', { method: 'POST', json: { blocks: 101 } });
ok(mine.status === 200, 'mine 101 blocks on the TEST node', JSON.stringify(mine.body).slice(0, 80));
const fund = await api('/api/regtest/fund', { method: 'POST', json: { walletId: wid, amount: 1.5 } });
ok(fund.status === 200, 'faucet funds the wallet on the TEST node', JSON.stringify(fund.body).slice(0, 80));
const wd = (await api(`/api/wallets/${wid}`)).body;
ok(wd.balance?.total >= 1.5 || wd.balance?.confirmed >= 1.5, 'wallet balance 1.5 tBTC', JSON.stringify(wd.balance));
const testChain = (await api('/api/blockchain')).body;
ok((testChain.blocks ?? testChain.height) !== Number(mcli('getblockcount')), 'wallet chain height differs from the myNode chain', `${testChain.blocks ?? testChain.height} vs ${mcli('getblockcount')}`);
ok(Number(mcli('getblockcount')) === standIn, 'mining touched only the test node (myNode height unchanged)');
ok(!mcli('listwallets').includes('Sim') && !mcli('listwallets').includes(wid), 'no app wallet was created on the myNode node', mcli('listwallets').replace(/\s+/g, ' '));
const testWallets = docker('exec', `${NAME}-testnode`, 'sh', '-c', `bitcoin-cli -regtest -datadir=/bitcoin -rpcuser=btctrust -rpcpassword="$TESTNODE_RPC_PASSWORD" listwallets`);
ok(testWallets.includes(wid ?? '###'), 'app wallet lives on the bundled test node', testWallets.replace(/\s+/g, ' ').slice(0, 120));

// 4. bitcoind-level allowlist, called from INSIDE the app container with the app's own credentials
const probe = (method: string, user = env.MAINNET_RPC_USER, pw = env.MAINNET_RPC_PASSWORD, wallet = '') => Number(docker('exec', '-e', `U=${user}`, '-e', `P=${pw}`, NAME, 'node', '-e',
  `fetch("http://host.docker.internal:${RPCPORT}/${wallet ? 'wallet/' + wallet : ''}",{method:"POST",headers:{authorization:"Basic "+Buffer.from(process.env.U+":"+process.env.P).toString("base64")},body:JSON.stringify({jsonrpc:"1.0",id:1,method:"${method}",params:[]})}).then(r=>console.log(r.status),()=>console.log(0))`).trim());
ok(probe('getblockchaininfo') === 200, 'bitcoind: btctrust user may call getblockchaininfo');
for (const m of ['getwalletinfo', 'sendtoaddress', 'sendrawtransaction', 'dumpprivkey', 'walletpassphrase', 'importdescriptors', 'signrawtransactionwithwallet', 'stop', 'createwallet'])
  ok(probe(m, undefined, undefined, m === 'getwalletinfo' ? 'mynode_hot' : '') === 403, `bitcoind refuses ${m} for btctrust (HTTP 403)`);
ok(probe('getwalletinfo', 'mynode', MYNODE_PW, 'mynode_hot') === 200, 'myNode\'s own "mynode" user still has full access (rpcwhitelistdefault=0)');

// 5. code-level allowlist against the myNode-generated bitcoin.conf, even with FULL-ACCESS credentials
const sent: string[] = [];
const full = new BitcoinRpc({ rpcHost: '127.0.0.1', rpcPort: RPCPORT, rpcUser: 'mynode', rpcPassword: MYNODE_PW, rpcTimeoutMs: 10000 });
const ro = new ReadOnlyRpc({ host: '127.0.0.1', port: RPCPORT, user: 'mynode', password: MYNODE_PW, expectChain: 'regtest' }, 5000,
  () => ({ call: (m: string, p?: unknown[]) => { sent.push(m); return full.call(m as any, p as any); } }) as any);
ok((await ro.call('getblockcount')) === standIn, 'ReadOnlyRpc reads the node');
for (const m of ['sendtoaddress', 'getwalletinfo', 'dumpprivkey', 'signrawtransactionwithwallet', 'sendrawtransaction', 'stop', 'GETBLOCK ']) {
  let refused = false; try { await ro.call(m as any, []); } catch (e) { refused = e instanceof ReadOnlyViolation; }
  ok(refused && !sent.includes(m), `ReadOnlyRpc refuses ${JSON.stringify(m)} before sending (full-access creds)`);
}

// 6. daily snapshot + timeline + realtime
const snap = await api('/api/mainnet/snapshot', { method: 'POST' });
ok(snap.status === 200 || snap.status === 201, 'daily snapshot from the myNode node', JSON.stringify(snap.body).slice(0, 120));
const tl = await api('/api/timeline');
ok(tl.status === 200, 'timeline endpoint', `${tl.status}`);
const wsOpen = (withCookie: boolean) => new Promise<string>((res) => {
  const ws = new WS(URL0.replace('http', 'ws') + '/api/ws', { headers: withCookie ? { cookie, origin: URL0 } : { origin: URL0 } });
  ws.on('open', () => { ws.close(); res('open'); }); ws.on('unexpected-response', (_q: any, r: any) => res(String(r.statusCode))); ws.on('error', () => res('error'));
});
ok((await wsOpen(false)) === '401', 'WebSocket without session -> 401');
ok((await wsOpen(true)) === 'open', 'WebSocket with session opens');
const health = docker('inspect', '-f', '{{.State.Health.Status}}', NAME).trim();
ok(health === 'healthy' || health === 'starting', 'docker HEALTHCHECK', health);
const uid = docker('exec', NAME, 'id', '-u').trim();
ok(uid !== '0', 'container runs as non-root', `uid ${uid}`);
const modeAfter = (await api('/api/mode')).body;
ok(modeAfter.mainnet.refused === 0, 'app made no refused mainnet calls during normal use', String(modeAfter.mainnet.refused));
const dbg = readFileSync(`${SIM}/mnt/hdd/mynode/bitcoin/regtest/debug.log`, 'utf8');
const denied = dbg.split('\n').filter((l) => /not allowed to call method/.test(l));
ok(denied.length >= 9, 'bitcoind debug.log records the denied probe calls', `${denied.length} lines, e.g. ${denied[0]?.slice(20, 110)}`);

console.log(`\n${pass} passed, ${fail} failed`);
writeFileSync(`${SIM}/verify.txt`, results.join('\n') + `\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
