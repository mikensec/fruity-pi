# certs/

Drop your corporate / TLS-inspection root CA here as a **PEM file ending in `.crt`** (e.g. `corp-root.crt`)
before `docker build` / `docker compose build`. It's added to the image's system trust store for
apt, git, curl, npm, Node (via `NODE_USE_SYSTEM_CA=1`), Python and the AWS SDK.

Files here other than this README are git-ignored so a company CA is never committed by accident.

Convert a DER/`.cer` file first: `openssl x509 -inform der -in corp.cer -out certs/corp-root.crt`
