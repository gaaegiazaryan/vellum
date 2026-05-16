# Security policy

Vellum handles financial data, even in pre-alpha. Take that seriously and the project will be useful; ignore it and the project is a liability.

## Reporting a vulnerability

Please report security issues privately, not through public issues or pull requests.

- Email: gaaegiazaryan@gmail.com
- Subject prefix: `[vellum-security]`
- If the issue is sensitive enough that even the subject would help an attacker, just send `[vellum-security] coordination request` and we will set up a private channel.

Expected response timeline:

- Acknowledgement of receipt within 72 hours.
- Initial assessment and a coordinated disclosure plan within 7 days.
- Fix and public disclosure as fast as severity demands, coordinated with the reporter.

If you do not hear back within 72 hours, the email may have been lost; open a regular issue with the subject `[vellum-security] follow-up needed` and no further detail, and we will reach out privately.

## What's in scope

- The Vellum API (`apps/api`), including authentication, authorization, idempotency, and request handling.
- The web app (`apps/web`), including session handling and any data exposed to the browser.
- Shared domain logic in `packages/core` and `packages/extraction` when the bug has security implications (e.g. a parser that accepts a payload that bypasses an invariant).
- Build and release tooling that runs against a contributor's machine or in CI.

## What's out of scope

- Issues that require physical access to a self-hosted deployment.
- Misconfigurations specific to a self-hoster's environment (firewall, reverse proxy, TLS termination). We will document hardening guidance, but a self-host's network posture is the operator's responsibility.
- Findings in third-party services we do not control (AI providers, Plaid, the hosting platform). Report those to the service directly.
- Spam or social-engineering against the project maintainer.

## What we ask of reporters

- Make a good-faith attempt to avoid privacy violations, destruction of data, and service degradation during testing.
- Give us a reasonable window to fix the issue before public disclosure. We will not invoke that window to delay indefinitely; we will agree on a date.
- If you tested against a third-party deployment (someone else's hosted Vellum), get the operator's permission first. Permission to test the project does not extend to their data.

## What we will not do

- Pursue legal action against good-faith security researchers who follow this policy.
- Require a non-disclosure agreement as a condition of fixing the issue. We will agree on a disclosure timeline; we will not buy silence.

## Credit

Reporters who follow this policy and want credit will be named in the release notes for the fix and in a `SECURITY-ACKNOWLEDGEMENTS.md` we will start once we have a first entry. Reporters who prefer to remain anonymous will be respected.

## Project status note

Vellum is pre-alpha and not deployed anywhere as a production service. The most likely security issues today are in build tooling, AI prompt injection paths in the extraction code (once it exists), and the eventual auth wiring. Reports against the current public surface are welcome; we will not pretend a finding is less important because the project is early.
