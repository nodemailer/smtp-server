# Claude Development Guidelines

## Project Overview

`smtp-server` is a Node.js library for creating SMTP and LMTP server instances on
the fly. It implements the server side of the SMTP/LMTP protocol (command
parsing, SASL authentication, STARTTLS, the DATA stream, PROXY protocol support)
and hands control to application-provided callbacks (`onConnect`, `onAuth`,
`onMailFrom`, `onRcptTo`, `onData`, etc.). It is part of the Nodemailer family.
It is written in TypeScript under `src/` and published to npm as a dual package:
ES modules in `dist/esm/` and CommonJS in `dist/cjs/`, each with its own type
declarations. Both `import { SMTPServer } from 'smtp-server'` and
`const { SMTPServer } = require('smtp-server')` work.

Homepage and documentation: <https://nodemailer.com/extras/smtp-server/>

## Project Structure

- `src/smtp-server.ts` - Public entry point. `SMTPServer` class: sets up the
  `net` server, implicit TLS and PROXY header handling, manages connections and
  TLS contexts, exposes the option handlers. Re-exports every public type and has
  a default export object `{ SMTPServer }`.
- `src/smtp-connection.ts` - Per-connection state machine. Parses SMTP commands,
  drives the protocol, enforces limits, invokes the application callbacks.
- `src/smtp-stream.ts` - Writable stream that splits the inbound socket into
  commands and the DATA payload; tracks `byteLength` and `sizeExceeded` in real
  time.
- `src/sasl.ts` - SASL authentication mechanisms (PLAIN, LOGIN, CRAM-MD5, XOAUTH2,
  XCLIENT). One default-export object, its methods run with the connection as `this`.
- `src/tls-options.ts` - Default TLS options (default-export function).
- `src/types.ts` - Public data shapes (`SMTPServerOptions`, `SMTPServerSession`,
  `SMTPServerAddress`, ...). They replace the community `@types/smtp-server`
  declarations: keep code written against those compiling (names, field types,
  handler signatures declared with method syntax so handler parameters may be
  subtypes).
- `src/vendor-types.d.ts` - Ambient declarations for `ipv6-normalize` and `punycode.js`.
- `scripts/build.js` - Compiles `src/` with `tsc` twice (`tsconfig.esm.json`,
  `tsconfig.cjs.json`), writes a module-format `package.json` into each output
  directory, and rewrites CommonJS modules that only have a default export so
  `require()` returns the value itself (the entry point gets `default` pointing at
  its exports object).
- `dist/` - Build output, gitignored, what gets published (`prepare` builds it).
- `examples/` - Runnable example servers (`server.js`, `lmtp.js`, ES modules that
  import the package by name, run `npm run build` first).
- `test/` - TypeScript tests (`*-test.ts`) on the Node.js test runner through tsx,
  plus the shared raw SMTP client `test/test-client.ts`. `test/package/` checks the
  built `dist/` output through the exports map in both module formats, from a
  separate consumer project, and type-checks consumer code against the shipped
  declarations.
- `compare/` - Postfix reference server (Docker) and a tool that replays
  scenarios against both servers (`compare/compare.ts`). Development aid, not part
  of the suite.

## Technology Stack

- **Runtime**: Node.js (see `engines` in `package.json`)
- **Language**: TypeScript (`tsconfig.base.json`: strict,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `erasableSyntaxOnly`,
  `isolatedModules`), compiled twice from the same sources
- **Runtime dependencies**: `nodemailer/lib/shared` (logging/helpers),
  `punycode.js` (IDN handling), `ipv6-normalize`
- **Dev/test**: Node.js test runner via `tsx`, c8, ESLint with typescript-eslint,
  Prettier, `pem` (test certificates)

This package has intentionally few runtime dependencies. Keep it that way.

## Development Commands

```
npm test               # Build, then run the full suite with the Node.js test runner
npm run test:coverage  # Same suite under c8 (thresholds in .c8rc.json, CI on Node 24)
npm run test:bun       # Build, then the suite under Bun (CI runs the latest Bun release)
npm run lint           # tsc --noEmit over src/ and test/, then ESLint
npm run typecheck      # tsc --noEmit only
npm run build          # Produce dist/
npm run format         # Prettier (js, cjs, ts, json, md)
npm run format:check   # Prettier check (CI)
npm run postfix:start  # Start the Postfix reference server (Docker)
npm run compare        # Replay compare/scenarios/*.txt against smtp-server and Postfix
npm run update         # Refresh dependencies: rm node_modules + lock, ncu -u, npm install
```

Single file: `node --import tsx --test test/protocol-test.ts`.

## Engine target and module format

- Source uses ES module syntax and is compiled to both formats from the same
  files, so code under `src/` must not use `import.meta`, `require`, `module`,
  `exports`, `__dirname`, `__filename`, top-level `await`, or JSON imports.
- `erasableSyntaxOnly` is on: no enums, no namespaces with runtime code, no
  parameter properties, no `<T>x` assertions.
- Relative imports carry the `.js` extension. Node builtins use the `node:` prefix.
- `@types/node` is pinned to the 20.x line (`.ncurc.cjs`).

## Export shapes (backwards compatibility)

- `require('smtp-server')` has exactly the enumerable keys it had as CommonJS
  (`SMTPServer`); `src/smtp-server.ts` is the one mixed module (named exports plus
  a default export object).
- `src/sasl.ts` and `src/tls-options.ts` have a single default export each, which
  `require()` returns directly. Do not add other runtime exports to them.
- Everything else uses named exports. `package.json` `exports` maps `./lib/*` (with
  and without `.js`) to the matching file of either build, `typesVersions` does
  the same for older TypeScript resolution, so `require('smtp-server/lib/...')`
  deep imports keep working.
- `test/package/package-test.ts` pins these shapes, including the pre-TypeScript
  export lists of every module.

## Testing

- `npm test` builds first (`pretest`), because `test/package/` loads `dist/`.
- Tests use `describe`/`it` from `node:test` and `assert` from
  `node:assert/strict`. A callback test is `it('...', (t, done) => { ... })`.
- The scripts pass `--test-force-exit`, `--test-concurrency=1` and
  `--test-timeout=60000`.
- Tests are self-contained: they spin up real `SMTPServer` instances on ephemeral
  ports and connect with a Nodemailer SMTP client or the raw client in
  `test/test-client.ts`. `pem` generates throwaway TLS certificates.
- `test/test-client.ts` checks every reply it reads against the RFC 5321 reply
  grammar. Prefer it (`chat`, `withServer`, `withClient`) for new protocol tests;
  `test/protocol-test.ts` holds table-driven cases per RFC.
- `test/fuzz-test.ts` is a seeded mutation fuzzer. Use
  `FUZZ_SEED=<n> FUZZ_ITERATIONS=<n>` to explore further.
- `npm run compare` (after `npm run postfix:start`) shows where smtp-server and
  Postfix reply differently. A difference is a hint to check the RFC, not proof
  of a bug.
- Always run `npm test` before committing and make sure it is green.
- Before committing code changes: `npm run format`, `npm run lint`, `npm test`;
  for non-trivial changes also consider `/simplify` and `/security-review`
  (command parsing, SASL, STARTTLS, the DATA stream and PROXY parsing are
  security-sensitive).

## Architecture Notes

- One `SMTPServer` listens; each accepted socket gets an `SMTPConnection` that
  owns the protocol state machine for that client.
- The connection feeds the socket through `SMTPStream`, which separates
  line-based commands from the DATA payload and surfaces the message body to the
  `onData` handler as a readable stream.
- The library never stores or queues messages itself. Size limits (the `size`
  option, `stream.sizeExceeded`) are advisory.
- Security-sensitive surfaces: command/address parsing, the DATA stream, SASL
  mechanisms, STARTTLS, and PROXY protocol parsing. Treat all of these as
  untrusted input.

## Package Maintenance

- **Updating dependencies**: run `npm run update`. It wipes `node_modules` and
  `package-lock.json`, runs `ncu -u` (honoring `.ncurc.cjs`), and reinstalls. Then
  run `npm test` and review the diff before committing.
- `.ncurc.cjs` holds `@types/node` and `typescript` to minor updates (Node 20
  API surface; typescript-eslint's peer range). Add pins there, with a comment,
  whenever an upgrade would pull in ESM-only runtime code or otherwise break
  compatibility.
- After `npm run update`, `npm audit` may report advisories in dev-only tooling.
  Do not force-fix these if the fix downgrades a pinned package - they do not
  affect the published library, which ships none of the dev dependencies. Prefer
  real upstream fixes over `npm audit fix --force`.

## @yao-pkg/pkg Compatibility (important)

Our applications (e.g. EmailEngine) are packaged into self-contained
single-file executables with **[@yao-pkg/pkg](https://github.com/yao-pkg/pkg)**.
`pkg` bundles CommonJS into a V8 snapshot and **cannot handle pure ESM
modules**. Because `smtp-server` and its dependency tree are bundled into those
executables, this package and everything it pulls in at runtime must stay
`pkg`-compatible:

- Keep the dual build. Never drop the CommonJS output in `dist/cjs/` or make it
  depend on ESM-only code.
- Do not add runtime dependencies that are pure ESM (ESM-only, no CommonJS
  entry point) or that themselves depend on pure-ESM packages.
- Before adding or upgrading a runtime dependency, verify it still works under
  `pkg`. If an upgrade goes ESM-only, pin it back in `.ncurc.cjs` with a comment.
  `test/package/package-test.ts` checks that every runtime dependency still loads
  with `require()`.
- Dev/test-only dependencies are not bundled by `pkg`, so ESM there is fine.

## Code Style Rules

- Match the existing style: 4-space indent, single quotes, semicolons, 160-column
  width (Prettier config in `.prettierrc`). Run `npm run format` before committing.
- Never use emojis in code or documentation, only printable ASCII characters.
- Use a single hyphen-minus (`-`) as a dash in comments and user-facing strings.
  Never use double hyphens (`--`), em dashes, or en dashes.
- `npm run lint` must pass (type-check plus ESLint with typescript-eslint, the
  type-aware rules on `src/`; config is the shared baseline, canonical form in
  `../nodemailer/eslint.config.js`, with `no-await-in-loop` turned off only for
  `test/` and `compare/`, which await sequentially on purpose). Fix lint errors; use
  an inline `eslint-disable-next-line` only for intentional patterns such as
  control-character regexes.

## Commits and Releases

- This repo uses **Conventional Commits** with
  [release-please](https://github.com/googleapis/release-please) (see
  `release-please-config.json`). The commit prefix drives the next version:
    - `fix:` -> patch release, `feat:` -> minor release,
      `feat!:`/`BREAKING CHANGE:` -> major release.
    - `chore:`, `docs:`, `ci:`, `test:`, `refactor:` -> no release; they just land
      on `master`.
- Do **not** list Claude or any AI assistant as a co-author or co-contributor in
  commit messages or PR descriptions (no `Co-Authored-By` trailer).
- For commits that do not change runtime behavior (docs, comments, CI/workflow
  tweaks, formatting), append `[skip ci]` to the commit message to avoid
  triggering the GitHub Actions workflows. Exception: do not add `[skip ci]` to
  commits using a `fix:` or `feat:` prefix - those must run so the release action
  is triggered.
- Pushing to `master` runs the `release` workflow: release-please opens/updates a
  release PR; merging it tags the version and publishes to npm with provenance.
- After pushing, check the GitHub Actions runs (`gh run list --branch master`)
  and report their status. If a run fails for an unrelated infrastructure reason (checkout reporting
  "account suspended", HTTP 403, other auth errors), check
  <https://www.githubstatus.com/> for an active incident before assuming the code
  is at fault.

## CI / Code Quality

- `.github/workflows/test.yml` - lint, format check and the test suite on
  maintained Node lines (currently 20.x, 22.x and 24.x, coverage on 24.x), plus Bun.
- `.github/workflows/release.yaml` - release-please + npm publish (Node 24).
- `.github/workflows/stale.yml` - stale issue/PR housekeeping.
- There is no CodeQL workflow (it was removed in July 2026) and code scanning
  default setup is not configured.

## Dependencies We Maintain

- **Nodemailer** (`../nodemailer`): `smtp-server` depends on
  `nodemailer/lib/shared` and is part of the same project family, maintained by
  us. The local development copy lives at `../nodemailer`. When an issue
  originates in Nodemailer's shared helpers, prefer fixing it in Nodemailer
  itself rather than working around it here.
