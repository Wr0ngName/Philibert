/**
 * Git credential helper that asks Philibert for the login.
 *
 * Git runs it as the last credential helper of a push or pull that
 * Philibert started (see GitCredentialBroker), with the action as its
 * argument and the credential description on stdin, in git's credential
 * protocol: `key=value` lines (protocol, host, path, username, ...).
 *
 *  - get:   pass the description to Philibert, which asks the user, and
 *           answer with the username and password they entered — or, when
 *           they cancelled, with `quit=1` so git stops asking;
 *  - store: the login worked (git also hands it to the user's own helpers,
 *           which keep it); Philibert is told so;
 *  - erase: the login was rejected; Philibert is told so.
 *
 * It reaches Philibert through the socket and token in its environment,
 * and does nothing at all without them. Run by Philibert's own executable
 * as plain Node (ELECTRON_RUN_AS_NODE), so it needs nothing installed.
 */

import net from 'node:net';

const action = process.argv[2];
const socketPath = process.env.PHILIBERT_GIT_CREDENTIAL_SOCKET;
const token = process.env.PHILIBERT_GIT_CREDENTIAL_TOKEN;
const operation = process.env.PHILIBERT_GIT_OPERATION;

if (!socketPath || !token || !['get', 'store', 'erase'].includes(action)) {
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const attributes = {};
  for (const line of input.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) attributes[line.slice(0, at)] = line.slice(at + 1);
  }

  const socket = net.connect(socketPath);
  let reply = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ token, operation, action, attributes })}\n`);
  });
  socket.on('data', (chunk) => {
    reply += chunk;
  });
  socket.on('end', () => {
    try {
      const answer = JSON.parse(reply);
      if (answer.quit) {
        process.stdout.write('quit=1\n');
      } else if (action === 'get' && typeof answer.username === 'string' && typeof answer.password === 'string') {
        process.stdout.write(`username=${answer.username}\npassword=${answer.password}\n`);
      }
    } catch {
      // No answer: git carries on as if this helper had nothing.
    }
    process.exit(0);
  });
  socket.on('error', () => process.exit(0));
});
