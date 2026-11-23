<?php
/**
 * Geo-Lo — tells the browser whether payments can actually be completed.
 *
 * The Paystack PUBLIC key is public by design (it is sent to every visitor's browser
 * anyway) and is hardcoded in index.html, so it is not served from here. The SECRET
 * key must never leave the server: it is read from the server's .env and used by
 * verify-payment.php to confirm each transaction with Paystack.
 *
 * This endpoint therefore only reports whether that secret key is configured, so the
 * checkout never opens a payment that could not be verified afterwards.
 */
require_once __DIR__ . '/config.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

/** A key that is missing or still looks like a placeholder counts as "not configured". */
$notConfigured = static function (string $key): bool {
    return $key === '' || strpos($key, 'xxxx') !== false;
};

echo json_encode([
    'ready' => !$notConfigured(trim(PAYSTACK_SECRET_KEY)),
]);
