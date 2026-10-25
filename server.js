// Ticho – server pro hru ve dvou.
// Spuštění:  node server.js        (jiný port: node server.js 9000)
// Server pošle hru do prohlížeče a propojí dva hráče. Nic se nemusí instalovat.
// První, kdo klikne na HRÁT VE DVOU, je hostitel (řídí příšery), druhý se k němu připojí.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.argv[2] || 8080;
const GAME = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url !== '/' && url !== '/index.html'){ res.writeHead(404); return res.end('Nenalezeno'); }
  fs.readFile(GAME, (err, data) => {
    if (err){ res.writeHead(500); return res.end('Chybí index.html'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

/* ---------- WebSocket (ruční, bez knihoven) ---------- */
const players = []; // [hostitel, kamarád]

function sendTo(p, text){
  const data = Buffer.from(text);
  let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536){ head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  try { p.sock.write(Buffer.concat([head, data])); } catch (e) {}
}
function readFrame(p){
  const b = p.buf;
  if (b.length < 2) return null;
  const op = b[0] & 15, masked = b[1] & 128;
  let len = b[1] & 127, off = 2;
  if (len === 126){ if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127){ if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  const mk = masked ? 4 : 0;
  if (b.length < off + mk + len) return null;
  const data = Buffer.from(b.subarray(off + mk, off + mk + len));
  if (masked) for (let i = 0; i < data.length; i++) data[i] ^= b[off + (i & 3)];
  p.buf = b.subarray(off + mk + len);
  return { op, data };
}

server.on('upgrade', (req, sock) => {
  if (req.url !== '/ws' || players.length >= 2){ sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const me = { sock, buf: Buffer.alloc(0), ip: sock.remoteAddress };
  const role = players.length === 0 ? 'host' : 'client';
  players.push(me);
  console.log(`Připojil se hráč (${role === 'host' ? 'hostitel' : 'kamarád'}) z ${me.ip}`);
  sendTo(me, JSON.stringify({ t: 'role', role }));
  if (players.length === 2) sendTo(players[0], JSON.stringify({ t: 'joined' }));

  sock.on('data', d => {
    me.buf = Buffer.concat([me.buf, d]);
    let f;
    while ((f = readFrame(me))){
      if (f.op === 8){ sock.end(); return; }                                      // zavření
      if (f.op === 9){ try { sock.write(Buffer.concat([Buffer.from([0x8a, f.data.length]), f.data])); } catch (e) {} continue; } // ping → pong
      if (f.op === 1){ const other = players.find(p => p !== me); if (other) sendTo(other, f.data.toString('utf8')); } // přepošli druhému
    }
  });
  const bye = () => {
    const i = players.indexOf(me); if (i < 0) return;
    players.splice(i, 1);
    console.log(`Hráč z ${me.ip} odešel.`);
    players.forEach(p => sendTo(p, JSON.stringify({ t: 'left' })));
  };
  sock.on('close', bye); sock.on('error', bye);
});

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
  console.log('\n  TICHO – server běží\n');
  console.log(`  Ty:        http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Kamarád:   http://${ip}:${PORT}`));
  console.log('\n  Oba klikněte na HRÁT VE DVOU. Server vypneš Ctrl+C.');
  console.log('  Kamarád mimo tvou síť: na routeru přesměruj port ' + PORT + ' a pošli mu svou veřejnou IP.\n');
});
