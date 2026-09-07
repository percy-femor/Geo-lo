FROM php:8.2-apache

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libpng-dev libjpeg62-turbo-dev libfreetype6-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j$(nproc) pdo pdo_mysql gd \
    && a2enmod rewrite headers alias \
    && rm -rf /var/lib/apt/lists/*

COPY docker/php.ini /usr/local/etc/php/conf.d/geo-lo.ini
COPY docker/apache-000-default.conf /etc/apache2/sites-available/000-default.conf
COPY docker/start.sh /usr/local/bin/start-geolo.sh
RUN chmod +x /usr/local/bin/start-geolo.sh \
    && sed -i 's/\r$//' /usr/local/bin/start-geolo.sh

WORKDIR /var/www/html
COPY api ./api
COPY frontend ./frontend
COPY database ./database

RUN chown -R www-data:www-data /var/www/html

EXPOSE 80
CMD ["start-geolo.sh"]
