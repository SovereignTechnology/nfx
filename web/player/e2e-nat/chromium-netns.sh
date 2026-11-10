#!/bin/sh
# Playwright's executablePath for a browser inside a network namespace (e2e-nat/driver.ts):
# it runs Playwright's own Chromium ($NFX_CHROMIUM) in the LAN namespace $NFX_NETNS with every
# argument Playwright gave. Playwright drives it over the pipe it hands down (fds 3 and 4),
# which `ip netns exec` keeps, so one driver controls browsers in two namespaces.
# Root only, as e2e-nat/run.sh runs it; it takes only the two LAN namespaces run.sh makes.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
case ${NFX_NETNS:-} in
  nfxha | nfxhb) ;;
  *) echo "chromium-netns: NFX_NETNS must be nfxha or nfxhb" >&2; exit 2 ;;
esac
[ -x "${NFX_CHROMIUM:-}" ] || { echo "chromium-netns: NFX_CHROMIUM is not an executable" >&2; exit 2; }
exec ip netns exec "$NFX_NETNS" "$NFX_CHROMIUM" "$@"
