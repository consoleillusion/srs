== Console <ref-console>

Status: *Implemented*.

`srs console` serves a browser page for using a server without writing a
client: connect to it, register, log in, and read and change resources. It uses
the same secure client as any application (`createSecureClient`), so every
request goes through the Noise transport and, after login, is signed.

=== Running it

```bash
# terminal 1: the API server, allowing the console's origin
SRS_CORS_ORIGINS=http://127.0.0.1:5735 bun srs serve

# terminal 2: the console page
bun srs console
```

Open `http://127.0.0.1:5735`, enter the server URL (`http://127.0.0.1:5734`)
and the fingerprint printed by `srs init`, and press _Connect_.

#table(
  columns: (auto, 1fr),
  table.header([*Option*], [*Meaning*]),
  [`--port`], [Port of the page; `5735` by default.],
  [`--host`], [Address to listen on; `127.0.0.1` by default, so only this machine can open it. Use `0.0.0.0` to open it from another machine, and add that origin (`http://<address>:5735`) to `SRS_CORS_ORIGINS`.],
)

The page and the API are on different ports, so they are different origins and
the browser needs `SRS_CORS_ORIGINS` to let the page call the server. The
command prints the exact value.

=== What it does

- *Server.* Connect with a URL and a pinned fingerprint. _Trust key from
  server_ fills in the fingerprint the server reports; use it only on a network
  you trust, since it is the step pinning protects. A signed key rotation
  updates the pin automatically.
- *Account.* Register, log in and log out. The password is never stored; the
  server URL, fingerprint and username are kept in the browser between visits.
- *Explorer.* Choose a resource from the catalog. _List_, _Get_, _Create_,
  _Update_ and _Delete_ run the matching JSON:API request; _Template_ fills in a
  document with the resource's writable attributes and relations. Any other
  request can be sent with a method and a path, such as
  `/article?filter[status]=draft&include=author`.
- *Requests.* Every request is logged with its status and time; the response
  body is shown in full.

=== Trust

The page is served by your own machine. It is only as trustworthy as the
origin it is loaded from (@threat-model): do not serve it over a network you do
not trust. It works on plain-HTTP pages, where browsers withhold
`crypto.subtle`, because the client uses pure JavaScript cryptography.
