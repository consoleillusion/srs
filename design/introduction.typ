= Introduction <introduction>

SRS (Secure Resource Server) turns a folder of JSON Schema files into a
backend: database tables, relations, views, migrations, a JSON:API, user
accounts and per-row access control. Application authors write schema, not
CRUD handlers.

This book records what SRS is for, the rules it follows and the reasons for
them. The reference documentation in `doc/` describes how to use what is built
today; this book is where design rules are decided, and the reference follows
it.

== Status markers

Each section starts with a status line:

- *Implemented* — the code follows this section.
- *Specified* — the design is settled and the code does not follow it yet.
- *Open* — the design is not settled.

== Conventions

The words _must_, _must not_, _should_ and _may_ have their usual
specification meanings. Identifiers, settings and wire values are written in
`monospace`. Byte strings are joined with `‖`.

== Reading order

@goals and @architecture give the overall shape. @schema to @http-api cover
the data and API layers. @threat-model to @external-identity specify security:
the attacker model, the encrypted transport, accounts and login, signed
requests, the account lifecycle and the optional identity-provider mode.
@operations covers running SRS, @decisions is the decision log, and @status
lists what is built, what is specified and how the protocol will be verified.
