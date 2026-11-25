#!/bin/sh
# Magician Clipper — container entrypoint for Render.
#
# Runs pending migrations + the idempotent seeder on every container
# start, then starts Apache on $PORT. This is needed because the
# manually created Render service has no pre-deploy command field
# (it is a gated feature), so render.yaml's preDeployCommand never
# runs there. Both commands are safe to re-run: migrate applies only
# pending migrations, and the seeder is CREATE-ONLY BY ROLE — it does
# nothing at all when an admin already exists, so panel-changed admin
# credentials and every saved setting survive every deploy (see
# DatabaseSeeder + tests/Feature/DeploySafetyTest.php).
set -e

php artisan migrate --force
php artisan db:seed --force

# Diagnostics for the deploy log (never block startup): show which
# VirtualHost file Apache will actually load and its DocumentRoot.
# The 721d87d deploy proved a config COPY can silently not take
# effect, so the next deploy log must show ground truth here.
apache2ctl -S 2>&1 || true
grep -h -A1 'DocumentRoot\|<Directory' /etc/apache2/sites-enabled/*.conf 2>/dev/null || true

sed -i "s/Listen 80/Listen ${PORT:-80}/" /etc/apache2/ports.conf
exec apache2-foreground
