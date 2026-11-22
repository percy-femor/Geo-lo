<?php
/**
 * Geo-Lo — Paystack payment verification endpoint.
 *
 * The frontend opens the Paystack checkout, and after Paystack reports success
 * it posts the transaction reference here. This script asks Paystack's API to
 * confirm that the transaction is genuinely successful before the site enables
 * the onboarding submit button.
 *
 * NOTE: This file must be served by PHP (e.g. XAMPP/Apache). Opening index.html
 * directly from the filesystem (file://) will prevent verification from running.
 */
declare(strict_types=1);

require __DIR__ . '/config.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['status' => 'error', 'message' => 'Method Not Allowed']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
if (!$input || empty($input['reference'])) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Invalid request']);
    exit;
}

$expectedPlan = isset($input['plan']) ? (string) $input['plan'] : null;
$result       = verify_paystack((string) $input['reference']);

if (!$result['ok']) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => $result['message']]);
    exit;
}

echo json_encode([
    'status'    => 'success',
    'reference' => $result['reference'],
    'amount'    => $result['amount'],
    'currency'  => $result['currency'],
    'plan'      => $result['plan'] ?? $expectedPlan,
    'channel'   => $result['channel'] ?? null,
]);
