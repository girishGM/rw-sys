#!/bin/sh
# Substitutes the backend hostname into nginx.render.conf's placeholder, then starts nginx
# normally. A plain `sed` on one literal placeholder, deliberately not the base nginx image's
# own envsubst-on-templates mechanism — that mechanism substitutes every `${NAME}`/`$NAME` it
# finds using the container's real environment, which would also blank out nginx's own runtime
# variables in this same file ($host, $remote_addr, $scheme, ...) since those aren't actual
# environment variables. A non-`$`-prefixed placeholder sidesteps the ambiguity entirely.
set -e

if [ -z "$API_UPSTREAM_HOST" ]; then
  echo "FATAL: API_UPSTREAM_HOST is not set." >&2
  echo "Set it to the backend service's bare hostname, e.g. reward-portal-api.onrender.com" >&2
  echo "(no https://, no trailing slash, no path)." >&2
  exit 1
fi

sed -i "s/__API_UPSTREAM_HOST__/${API_UPSTREAM_HOST}/g" /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
