<?php
/**
 * Geo-Lo — hands the browser the Paystack public key.
 *
 * The key is read from the server's .env instead of being written into index.html, so
 * the public key and the secret key always come from the same Paystack account and no
 * key is committed to the repository.
 */
require_once __DIR__ . '/config.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

/** A key that is missing or still looks like a placeholder counts as "not configured". */
$notConfigured = static function (string $key): bool {
    return $key === '' || strpos($key, 'xxxx') !== false;
};

$publicKey = trim(PAYSTACK_PUBLIC_KEY);
$secretKey = trim(PAYSTACK_SECRET_KEY);

echo json_encode([
    'public_key' => $notConfigured($publicKey) ? '' : $publicKey,
    // Only advertise readiness when server-side verification can succeed as well, so the
    // form never opens a checkout whose payment could not be confirmed afterwards.
    'ready' => !$notConfigured($publicKey) && !$notConfigured($secretKey),
]);
