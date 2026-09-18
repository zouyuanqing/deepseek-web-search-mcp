# Security

## Secrets

Never commit API keys, `.env` files, deployment credentials, or private
infrastructure addresses. The server reads all credentials from environment
variables.

Use `.env.example` as the list of supported variables. Real values should be
stored in the operating system's user environment or a secret manager.

## Network boundaries

The bundled SearXNG deployment binds to `127.0.0.1` by default. If it is exposed
to a LAN, set `SEARXNG_BIND_IP`, `SEARXNG_BASE_URL`, and
`SEARXNG_LAN_CIDR` explicitly. Do not expose SearXNG directly to the public
internet.

## Reporting

Open a private security advisory in the GitHub repository for suspected
credential leaks or vulnerabilities.
