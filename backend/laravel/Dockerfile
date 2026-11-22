# Magician Clipper — Laravel API image for Render (Free plan).
#
# PHP 8.3 + Apache. This service ONLY serves the Laravel API: no Node,
# no FFmpeg, no Python, no video engine. Heavy video processing runs on
# the separate Muse worker (dev VM), not on this instance — see
# docs/deployment-render-free.md.
#
# Build context is backend/laravel (see render.yaml: dockerContext).
# Render injects $PORT at runtime; Apache is rebound to it in CMD.

FROM php:8.3-apache

# System libraries needed by the PHP extensions below.
# NOTE: libsqlite3-dev is REQUIRED by the sqlite3 extension
# (docker-php-ext-install fails without it: "Package 'sqlite3',
# required by 'virtual:world', not found" — broke the first Render
# build, 2026-11-22). Do not remove it while pdo_sqlite/sqlite3
# are installed below.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        libsqlite3-dev \
        libzip-dev \
        libpng-dev \
        libonig-dev \
        libxml2-dev \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# PHP extensions the app needs:
#   pdo_sqlite + sqlite3 — local SQLite default (spec §5)
#   pdo_pgsql             — Render's free PostgreSQL database
#   mbstring, xml, curl, zip, gd — Laravel + file handling
RUN docker-php-ext-install -j"$(nproc)" \
        pdo_sqlite sqlite3 pdo_pgsql mbstring xml curl zip gd

# Upload limits: the app accepts multi-hundred-MB video uploads, but PHP
# defaults cap uploads at 2M (upload_max_filesize) and POST bodies at 8M
# (post_max_size). Set both in the image itself (conf.d snippet) so the
# setting travels with every deploy — a php.ini edit on the dev VM does
# not. 2048M matches the worker's 2 GiB direct-download cap.
RUN printf 'upload_max_filesize = 2048M\npost_max_size = 2048M\n' \
        > /usr/local/etc/php/conf.d/uploads.ini

# Composer, from the official image (not installed via apt).
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Apache: mod_rewrite for Laravel's public/.htaccess front controller,
# and serve from backend/laravel/public instead of /var/www/html.
RUN a2enmod rewrite
ENV APACHE_DOCUMENT_ROOT=/var/www/html/public
RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf \
    && sed -ri -e 's!/var/www/!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf

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
