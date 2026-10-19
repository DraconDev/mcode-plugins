# Security policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:
**security@dracsharp.dev**, or GitHub's [private vulnerability reporting][priv] for this
repository. Include the plugin, the version, and the steps to reproduce. You will get an
acknowledgement within a few days.

Please do not test against anybody else's browser session, account, or data. Use a throwaway
account and a browser profile you do not mind losing.

[priv]: https://github.com/DraconDev/mcode-plugins/security/advisories/new

## What these plugins touch

Two of the four plugins are security-relevant by design, and it is worth being explicit about what
they reach.

### `mcode-chrome` drives a signed-in browser

It runs in the user's real Chrome, in the user's real profile, with the user's real cookies. It can
read the page, act on the page, and capture network traffic — including response headers, which
can carry session and API credentials.

What it does about that:

- **Response headers are redacted before they reach a tool result.** The redaction is keyed on
  header *names* and covers `authorization`, `cookie`, `set-cookie`, `x-api-key`, `token`, `auth`,
  `secret`, `password` and the rest of the usual suspects. It handles the shapes the companion
  extension actually produces — an array of `[name, value]` pairs and a raw CRLF header block — not
  just the convenient object shape.
- **Page-changing tools need authorization.** `authorize` / `revoke` gate the tools that click,
  type, navigate or upload. The read-only tools stay available.
- **The bridge is loopback-only.** It binds `127.0.0.1` and rejects a request that carries a
  browser `Origin`, so a web page cannot drive it. A local process can, which is the same trust
  level the underlying pi-chrome bridge uses.
- **A file path is contained to the workspace.** A relative `savePath` resolves against the
  workspace and cannot escape it; a `baseDir` outside the workspace is refused.

What it does not do: it does not sandbox the page, and it does not stop a prompt injection in the
page content from steering the model. Treat any page the plugin opens as untrusted input, and use
`authorize` deliberately.

### The image plugins hold credentials

`mcode-agnes` and `mcode-codex` read a credential from `~/.pi/agent/auth.json` or from an
environment variable, and use it to call the provider. They never log it, never echo it, and never
put it in a tool result or an error message. The codex plugin refreshes an expired token in memory
only and never writes back to pi's auth file.

### The runtime repair scripts patch a third-party install

`scripts/apply-mcode-rm-shim-fix.mjs` and `scripts/apply-mcode-llm-retry-policy.mjs` edit files
inside the installed `@minimax-ai/code` package. They are:

- **Opt-in.** Nothing installs them automatically; you run them.
- **Reversible.** `--revert` puts the original back, and the original chunk is kept beside the
  patched one as `<chunk>.orig.bak`.
- **Narrow.** Each script refuses to continue if it finds a bundle shape it does not recognise,
  rather than guessing.

They are undone by `mcode update`, which replaces the bundle wholesale. Re-run them afterwards if
you want the fix back.

## Supported versions

| Plugin | Version |
| --- | --- |
| `mcode-chrome` | 1.0.0 |
| `mcode-agnes` | 1.0.0 |
| `mcode-codex` | 1.0.0 |
| `mcode-retry-on-error` | 1.0.1 |

Fixes land on `main` and are released by tagging. There is no release schedule; the repository is
maintained as it comes up.
