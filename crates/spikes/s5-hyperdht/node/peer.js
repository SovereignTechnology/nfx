'use strict'
// Spike S5': the Node peer. Same CLI and wire as the Rust peer (src/main.rs), so run.sh can
// pair any two. The wire is NFX-12: nfx/files/1 (types 0 get, 1 data, 2 end, 3 missing) and
// nfx/pay/1 (type 0, one JSON message) on Protomux, channel id = the video address.
//
//   node peer.js testnet --host H --port P [--size 3]
//   node peer.js relay   --bootstrap H:P --seed S
//   node peer.js serve   --bootstrap H:P --seed S --bytes N [--allow HEX] [--relay HEX]
//                        [--timeout-ms T]
//   node peer.js fetch   --bootstrap H:P --seed S --peer HEX --sha HEX --bytes N
//                        [--relay HEX] [--expect-refused] [--keepalive-ms K] [--idle-ms I]
//                        [--expect-closed]
//
// Every role prints one JSON line when ready or done; fetch exits 0 only when every check held.

const crypto = require('crypto')
const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')
const { Server: RelayServer } = require('blind-relay')

const VIDEO = 'nfx:regtest:1:s5-spike-video'
const FRAME = 65536

function args() {
  const [role, ...rest] = process.argv.slice(2)
  const o = { role }
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i].replace(/^--/, '')
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) o[k] = true
    else o[k] = rest[++i]
  }
  return o
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function keyPair(seed) {
  return DHT.keyPair(crypto.createHash('sha256').update(seed).digest())
}

function bootstrap(o) {
  const [host, port] = o.bootstrap.split(':')
  return [{ host, port: Number(port) }]
}

function u32(n) {
  const b = b4a.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

// The served file: N pseudo-random bytes, generated once.
function fileOf(bytes) {
  const buf = crypto.randomBytes(bytes)
  return { buf, sha: crypto.createHash('sha256').update(buf).digest('hex') }
}

function channels(socket) {
  const mux = Protomux.from(socket)
  const id = b4a.from(VIDEO)
  const files = mux.createChannel({ protocol: 'nfx/files/1', id })
  const pay = mux.createChannel({ protocol: 'nfx/pay/1', id })
  return { mux, files, pay }
}

// Protomux's send() returns the stream's write(): false once streamx's buffer is past its
// high-water mark (16 KiB), so waiting for 'drain' keeps the queue well under NFX-12 §4's 256 KiB cap.
async function drained(socket, writable) {
  if (writable) return
  await new Promise((resolve) => socket.once('drain', resolve))
}

async function testnet(o) {
  const t = await createTestnet(Number(o.size || 3), { host: o.host, port: Number(o.port) })
  out({ role: 'testnet', bootstrap: `${o.host}:${o.port}`, nodes: t.nodes.length })
}

async function relay(o) {
  const dht = new DHT({ bootstrap: bootstrap(o) })
  const kp = keyPair(o.seed)
  const relayServer = new RelayServer({
    createStream(opts) {
      return dht.createRawStream({ ...opts, framed: true })
    }
  })
  const server = dht.createServer((socket) => {
    const session = relayServer.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})
  })
  await server.listen(kp)
  out({ role: 'relay', impl: 'node', relay: b4a.toString(kp.publicKey, 'hex') })
}

async function serve(o) {
  const dht = new DHT({ bootstrap: bootstrap(o) })
  const kp = keyPair(o.seed)
  const file = fileOf(Number(o.bytes))
  const allow = o.allow ? b4a.from(o.allow, 'hex') : null
  const server = dht.createServer(
    {
      firewall(remotePublicKey) {
        return allow !== null && !b4a.equals(remotePublicKey, allow)
      },
      ...(o.relay ? { relayThrough: b4a.from(o.relay, 'hex') } : {})
    },
    (socket) => onConnection(socket, file, o)
  )
  await server.listen(kp)
  out({ role: 'serve', impl: 'node', peer: b4a.toString(kp.publicKey, 'hex'), sha: file.sha, bytes: file.buf.length })
}

function onConnection(socket, file, o) {
  socket.on('error', () => {})
  if (o['timeout-ms']) socket.setTimeout(Number(o['timeout-ms']))
  const { files, pay } = channels(socket)
  const msg = pay.addMessage({
    encoding: c.raw,
    onmessage(buf) {
      const m = JSON.parse(b4a.toString(buf))
      if (m.t === 'hello') {
        msg.send(b4a.from(JSON.stringify({ t: 'quote', price_per_chunk: 1, mints: ['https://mint.example'], window: 8, served: 0, accepted_upto: 0, spent_total: 0 })))
      } else if (m.t === 'pay') {
        msg.send(b4a.from(JSON.stringify({ t: 'ack', accepted_upto: m.upto_chunk, spent_total: m.upto_chunk })))
      }
    }
  })
  const get = files.addMessage({
    encoding: c.raw,
    async onmessage(buf) {
      if (buf.length !== 36) return files.close()
      const req = buf.readUInt32LE(0)
      const sha = b4a.toString(buf.subarray(4), 'hex')
      if (sha !== file.sha) return missing.send(u32(req))
      for (let at = 0; at < file.buf.length; at += FRAME) {
        await drained(socket, data.send(b4a.concat([u32(req), file.buf.subarray(at, at + FRAME)])))
      }
      end.send(u32(req))
    }
  })
  const data = files.addMessage({ encoding: c.raw })
  const end = files.addMessage({ encoding: c.raw })
  const missing = files.addMessage({ encoding: c.raw })
  void get
  files.open()
  pay.open()
}

async function fetch(o) {
  const dht = new DHT({ bootstrap: bootstrap(o), ephemeral: true })
  const kp = keyPair(o.seed)
  const started = Date.now()
  const socket = dht.connect(b4a.from(o.peer, 'hex'), {
    keyPair: kp,
    ...(o.relay ? { relayThrough: b4a.from(o.relay, 'hex') } : {})
  })
  const result = { role: 'fetch', impl: 'node', ok: false }
  let reported = false
  const done = (extra) => {
    if (reported) return // one JSON line per run, whichever path finishes first
    reported = true
    Object.assign(result, extra)
    out(result)
    socket.destroy()
    dht.destroy().then(() => process.exit(result.ok ? 0 : 1))
  }
  const deadline = setTimeout(() => done({ error: 'timeout' }), 90000)

  socket.on('error', (err) => {
    clearTimeout(deadline)
    if (o['expect-refused']) return done({ ok: true, refused: true, error: err.code || err.message })
    if (o['expect-closed'] && result.idle_started) return done({ ok: true, closed_after_idle: true })
    done({ error: err.code || err.message })
  })
  socket.on('close', () => {
    if (o['expect-closed'] && result.idle_started) {
      clearTimeout(deadline)
      done({ ok: true, closed_after_idle: true })
    }
  })
  await new Promise((resolve) => socket.once('open', resolve))
  if (o['expect-refused']) {
    // A server without a firewall callback (peeroxide) can only drop the connection after
    // the handshake: count that as a refusal, but say which kind it was.
    clearTimeout(deadline)
    const closed = await new Promise((resolve) => {
      if (socket.destroyed) return resolve(true)
      const t = setTimeout(() => resolve(false), 5000)
      socket.once('close', () => {
        clearTimeout(t)
        resolve(true)
      })
    })
    return done({ ok: closed, refused: closed ? 'after-handshake' : 'no' })
  }
  result.connect_ms = Date.now() - started
  result.remote_key_ok = b4a.toString(socket.remotePublicKey, 'hex') === o.peer
  result.remote_host = socket.rawStream ? socket.rawStream.remoteHost : null
  if (o['keepalive-ms'] !== undefined) socket.setKeepAlive(Number(o['keepalive-ms']))

  if (o['idle-ms']) {
    // Liveness: say nothing for idle-ms. With a keepalive the connection must survive; with
    // none, a server timeout below idle-ms must close it (--expect-closed).
    result.idle_started = true
    await new Promise((resolve) => setTimeout(resolve, Number(o['idle-ms'])))
    clearTimeout(deadline)
    if (o['expect-closed']) return done({ ok: false, error: 'still open after idle' })
    return done({ ok: !socket.destroyed, survived_idle: !socket.destroyed })
  }

  const { files, pay } = channels(socket)
  const bytes = Number(o.bytes)
  let received = 0
  const hash = crypto.createHash('sha256')
  let gotMissing = false
  let quoted
  const quote = new Promise((resolve) => (quoted = resolve))
  let acked
  let paySentAt = 0
  const msg = pay.addMessage({
    encoding: c.raw,
    onmessage(buf) {
      const m = JSON.parse(b4a.toString(buf))
      if (m.t === 'quote') quoted(m)
      if (m.t === 'ack' && acked) acked(Date.now() - paySentAt)
    }
  })
  let ended
  const finished = new Promise((resolve) => (ended = resolve))
  let missed
  const missingSeen = new Promise((resolve) => (missed = resolve))
  const get = files.addMessage({ encoding: c.raw })
  files.addMessage({
    encoding: c.raw,
    onmessage(buf) {
      if (buf.readUInt32LE(0) !== 1) return
      received += buf.length - 4
      if (received > bytes) return done({ error: 'more bytes than the size' })
      hash.update(buf.subarray(4))
    }
  })
  files.addMessage({
    encoding: c.raw,
    onmessage(buf) {
      if (buf.readUInt32LE(0) === 1) ended()
    }
  })
  files.addMessage({
    encoding: c.raw,
    onmessage(buf) {
      if (buf.readUInt32LE(0) === 2) {
        gotMissing = true
        missed()
      }
    }
  })
  files.open()
  pay.open()

  msg.send(b4a.from(JSON.stringify({ t: 'hello', video: VIDEO, session: '0123456789abcdef0123456789abcdef' })))
  await quote
  const t0 = Date.now()
  get.send(b4a.concat([u32(1), b4a.from(o.sha, 'hex')]))
  // A pay/1 message sent while the file streams: its round trip shows whether pay waits
  // behind the data (NFX-12 §4, the 256 KiB send cap).
  const payRtt = new Promise((resolve) => (acked = resolve))
  setTimeout(() => {
    paySentAt = Date.now()
    msg.send(b4a.from(JSON.stringify({ t: 'pay', upto_chunk: 1, token: 'cashuBspike' })))
  }, 50)
  await finished
  const ms = Date.now() - t0
  const pay_rtt_ms = await Promise.race([payRtt, new Promise((resolve) => setTimeout(() => resolve(null), 10000))])
  get.send(b4a.concat([u32(2), b4a.alloc(32, 0xab)]))
  await Promise.race([missingSeen, new Promise((resolve) => setTimeout(resolve, 10000))])
  clearTimeout(deadline)
  const shaOk = hash.digest('hex') === o.sha
  done({
    ok: shaOk && received === bytes && gotMissing && result.remote_key_ok,
    bytes: received,
    sha_ok: shaOk,
    missing_ok: gotMissing,
    ms,
    mbit_s: Math.round(((received * 8) / 1e6 / (ms / 1000)) * 10) / 10,
    pay_rtt_ms
  })
}

const o = args()
const roles = { testnet, relay, serve, fetch }
if (!roles[o.role]) {
  process.stderr.write('usage: peer.js testnet|relay|serve|fetch …\n')
  process.exit(2)
}
roles[o.role](o).catch((err) => {
  out({ role: o.role, impl: 'node', ok: false, error: err.message })
  process.exit(1)
})
