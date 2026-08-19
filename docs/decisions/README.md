# Architecture decision records

One file per decision that was not obvious, in the form: context, decision, consequences —
including the ones we did not like.

A decision belongs here when reversing it later would be expensive, or when a future reader
would otherwise reasonably ask "why on earth is it done this way".

| #                                              | Decision                                           |
| ---------------------------------------------- | -------------------------------------------------- |
| [0001](0001-fastify-over-nestjs.md)            | Fastify over NestJS                                |
| [0002](0002-composite-tenant-foreign-keys.md)  | Composite tenant foreign keys                      |
| [0003](0003-rls-as-defense-in-depth.md)        | RLS as defense in depth, not the primary control   |
| [0004](0004-immutable-price-rows.md)           | Immutable, versioned price rows                    |
| [0005](0005-permission-snapshot-on-session.md) | Permission snapshot on the session                 |
| [0006](0006-conservative-gps-distance.md)      | Conservative GPS distance                          |
| [0007](0007-partial-locale-catalogs.md)        | Ship partial locale catalogs with per-key fallback |
| [0008](0008-defer-us-sales-tax.md)             | Defer US sales tax to the payment provider         |
