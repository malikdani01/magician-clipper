#!/bin/sh
# Magician Clipper — container entrypoint for Render.
#
# Runs pending migrations + the idempotent seeder on every container
# start, then starts Apache on $PORT. This is needed because the
# manually created Render service has no pre-deploy command field
# (it is a gated feature), so render.yaml's preDeployCommand never
# runs there. Both commands are safe to re-run: migrate applies only
# pending migrations, and the seeder creates the admin user with
# firstOrCreate (only when ADMIN_EMAIL + ADMIN_PASSWORD are set).
set -e

php artisan migrate --force
php artisan db:seed --force

sed -i "s/Listen 80/Listen ${PORT:-80}/" /etc/apache2/ports.conf
exec apache2-foreground
