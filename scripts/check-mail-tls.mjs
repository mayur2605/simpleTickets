// Connectivity only: no authentication, mailbox access, or email transmission.
import tls from 'node:tls';
const host = 'mail.allcheckservices.com';
const results = await Promise.all([993, 465].map(port => new Promise(resolve => {
  let done = false;
  const socket = tls.connect({host, port, servername: host, rejectUnauthorized: true});
  function finish(result) { if (done) return; done = true; socket.destroy(); resolve(result); }
  socket.setTimeout(10000);
  socket.on('secureConnect', () => finish({host, port, verified: socket.authorized, protocol: socket.getProtocol(), issuer: socket.getPeerCertificate().issuer?.CN, validTo: socket.getPeerCertificate().valid_to}));
  socket.on('error', error => finish({host, port, error: error.message}));
  socket.on('timeout', () => finish({host, port, error: 'Connection timed out'}));
})));
console.log(JSON.stringify({checkedAt: new Date().toISOString(), results}, null, 2));
if (results.some(result => result.error)) process.exitCode = 1;
