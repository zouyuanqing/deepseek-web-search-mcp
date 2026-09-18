# SearXNG Deployment

Copy this directory to a server, replace `__SEARXNG_SECRET__` with a generated
random value, then run:

```bash
cp .env.example .env
docker compose up -d
curl -fsS 'http://127.0.0.1:8888/search?q=test&format=json'
```

By default, the service binds to `127.0.0.1`. Set `SEARXNG_BIND_IP` to a LAN
address when remote LAN clients need access, and set `SEARXNG_BASE_URL` to the
same externally reachable URL.

Install `firewall.sh` as `/usr/local/sbin/searxng-docker-firewall.sh` and
`searxng-docker-firewall.service` under `/etc/systemd/system/` so the Docker
forwarding rule is restored after reboot.

Copy `firewall.env.example` to `/etc/default/searxng-docker-firewall` and set
the actual port and trusted LAN CIDR.
