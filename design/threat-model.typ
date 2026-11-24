== Threat model <threat-model>

Status: *Implemented*: the Noise transport is built to it, and the attack
tests check each property (@status).

=== Deployment assumed

SRS runs on a network the operator does not fully trust, possibly without TLS.
Clients are configured with the server's key fingerprint (@server-keys) before
first contact.

=== Attackers

#table(
  columns: (auto, 1fr),
  table.header([*Attacker*], [*Can*]),
  [Passive network], [Read every packet between client and server.],
  [Active network], [Read, drop, delay, reorder, replay, alter and inject packets; impersonate either end at the network layer.],
  [Malicious client], [Send any bytes to any route; hold a valid account.],
  [Database thief], [Read a copy of the database, including backups.],
  [Server key thief], [Hold the server's private keys.],
  [Dishonest operator], [Run modified server code and write to the database, then claim a user signed something.],
)

=== Properties required

#table(
  columns: (1fr, 1fr),
  table.header([*Property*], [*Holds against*]),
  [Passwords are never learnt and cannot be guessed offline], [All of the above. The database thief needs the server's OPAQUE key and still only gets online guesses.],
  [Requests and responses are confidential], [Passive and active network.],
  [Requests and responses cannot be altered, replayed, reordered undetected, or moved between sessions], [Active network.],
  [The client is talking to the real server], [Active network, as long as the pinned key is genuine.],
  [A request comes from the user it claims], [Active network, malicious clients, database thief.],
  [A retained signature proves the user's key signed it], [Dishonest operator, for signatures made before any admin reset of that user (@recovery).],
  [Past traffic stays secret after key theft], [Server key thief: forward secrecy through ephemeral keys.],
  [Login rate limits cannot be bypassed by forging an address], [Malicious client.],
)

=== Outside the model

- *Client code delivered over the untrusted network.* If a browser loads the
  application's JavaScript over plain HTTP, an active attacker can replace it
  and read the password as it is typed. No transport protects code that the
  attacker writes. Under `noise`, client code must arrive by a trusted path: a
  Bun or Node program, a CLI, a desktop app, a browser extension, or a web app
  loaded from a trusted origin. Browsers on plain-HTTP pages also lack
  `crypto.subtle`, so the client uses pure-JS primitives
  (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`) and
  `crypto.getRandomValues`.
- *A compromised client device.* Malware on the device can use an unlocked
  session.
- *Traffic analysis.* Sizes and timing of requests are visible.
- *Denial of service.* An active attacker can always drop traffic.
- *Registration before the key is pinned.* Pinning is the trust anchor; a
  client given a wrong fingerprint talks to whoever holds that key.
