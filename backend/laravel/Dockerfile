# Magician Clipper — Laravel API image for Render (Free plan).
#
# PHP 8.3 + Apache. This service ONLY serves the Laravel API: no Node,
# no Python, no video engine. Heavy video processing runs on the
# separate Muse worker (dev VM), not on this instance — see
# docs/deployment-render-free.md. ffmpeg IS installed here, though:
# the API host itself needs ffprobe/ffmpeg for brand-asset duration
# validation and on-demand per-clip audio extraction (both are light
# probe/extract calls, not rendering).
#
# Build context is backend/laravel (see render.yaml: dockerContext).
# Render injects $PORT at runtime; Apache is rebound to it in CMD.

FROM php:8.3-apache

# System libraries needed by the PHP extensions below.
# NOTE (2026-11-22): do NOT add sqlite extensions back. The
# `sqlite3` extension broke the Render build twice in a row — first
# "Package 'sqlite3' not found" (missing libsqlite3-dev), then
# "Cannot find config.m4" from phpize during docker-php-ext-install.
# The production image does not need SQLite at all: Render runs
# PostgreSQL (DB_CONNECTION=pgsql is set in the dashboard), and no
# code in app/, routes/ or the seeders touches SQLite — it is only
# the local-dev default and the phpunit driver, neither of which
# runs inside this image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        postgresql-client \
        libpq-dev \
        libcurl4-openssl-dev \
        libzip-dev \
        libpng-dev \
        libonig-dev \
        libxml2-dev \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# PHP extensions the app needs:
#   postgresql-client     — pg_dump + psql for `php artisan db:backup` /
#                           db:restore (Batch 9 deploy-safety work).
#                           The PHP extension above (pdo_pgsql) does NOT
#                           ship these binaries, so the backup command
#                           cannot work without this package.
#   mbstring, xml, curl, zip, gd — Laravel + file handling
RUN docker-php-ext-install -j"$(nproc)" \
        pdo_pgsql mbstring xml curl zip gd

# Upload limits: the app accepts multi-hundred-MB video uploads, but PHP
# defaults cap uploads at 2M (upload_max_filesize) and POST bodies at 8M
# (post_max_size). Set both in the image itself (conf.d snippet) so the
# setting travels with every deploy — a php.ini edit on the dev VM does
# not. 2048M matches the worker's 2 GiB direct-download cap.
RUN printf 'upload_max_filesize = 2048M\npost_max_size = 2048M\n' \
        > /usr/local/etc/php/conf.d/uploads.ini

# Composer, from the official image (not installed via apt).
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Apache: mod_rewrite for Laravel's public/.htaccess front controller.
# The VirtualHost is replaced outright (see docker-000-default.conf):
# literal DocumentRoot /var/www/html/public — the stock ENV + sed
# pattern that rewrote it to `DocumentRoot ${APACHE_DOCUMENT_ROOT}`
# silently left Apache serving /var/www/html, so /up 403'd and the
# Render health check timed out (deploy fdcc6c6, 2026-11-22).
# apache2.conf is left untouched: its stock <Directory /var/www/>
# "Require all granted" stays intact.
RUN a2enmod rewrite
# Copy to BOTH sites-available and sites-enabled. In the stock
# php:8.3-apache image sites-enabled/000-default.conf is a symlink
# to sites-available, but the 721d87d deploy proved the
# sites-available copy alone did not take effect (Apache still
# served /var/www/html: /up 404, HEAD / 403) — so the enabled file
# may be a stale regular copy. Writing both paths covers either
# layout; when it is a symlink the second COPY just writes through
# to the same target file.
COPY docker-000-default.conf /etc/apache2/sites-available/000-default.conf
COPY docker-000-default.conf /etc/apache2/sites-enabled/000-default.conf

WORKDIR /var/www/html

# Install PHP dependencies first (better layer caching).
# --no-scripts: composer.json's post-autoload-dump hook runs artisan,
# which must not run before the app files and env vars exist.
COPY composer.json composer.lock ./
RUN composer install --no-dev --optimize-autoloader --no-interaction --no-scripts

COPY . .

# Laravel needs writable storage/ and bootstrap/cache/ at runtime.
RUN chown -R www-data:www-data storage bootstrap/cache \
    && chmod -R 775 storage bootstrap/cache

# No .env file is baked into the image. All configuration comes from
# Render environment variables (see render.yaml). Render's filesystem
# is ephemeral: anything written under storage/ disappears on redeploy.
#
# Container start: docker-entrypoint.sh runs pending migrations +
# the idempotent seeder, rebinds Apache to $PORT, then starts Apache.
RUN chmod +x docker-entrypoint.sh
CMD ["sh", "./docker-entrypoint.sh"]
