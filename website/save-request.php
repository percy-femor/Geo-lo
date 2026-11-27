<?php
/**
 * Geo-Lo — onboarding request intake.
 *
 * Called by the Get Started form. Verifies the Paystack payment server-side
 * (never trusting the browser) and stores the request so the owner console can
 * list every company that paid and email them back.
 */
declare(strict_types=1);

require __DIR__ . '/config.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['status' => 'error', 'message' => 'Method Not Allowed']);
    exit;
}

/**
 * Is this address already spoken for? Returns a short reason when it is, or null
 * when it is free. Workers, admins and earlier onboarding requests all hold an
 * address, so the same inbox cannot register a second time.
 */
function emailConflict(PDO $pdo, string $email): ?string
{
    $email = trim($email);
    if ($email === '') {
        return null;
    }
    if (strtolower($email) === 'boss@geo-lo') {
        return 'it is reserved for the Geo-Lo owner';
    }

    $stmt = $pdo->prepare('SELECT id FROM workers WHERE LOWER(email) = LOWER(?) LIMIT 1');
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        return 'it already belongs to a worker account';
    }

    $stmt = $pdo->prepare('SELECT id FROM admins WHERE LOWER(email) = LOWER(?) LIMIT 1');
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        return 'it already belongs to an admin account';
    }

    $stmt = $pdo->prepare('SELECT id FROM onboarding_requests WHERE LOWER(contact_email) = LOWER(?) OR LOWER(admin_email) = LOWER(?) LIMIT 1');
    $stmt->execute([$email, $email]);
    if ($stmt->fetch()) {
        return 'it is already on an existing onboarding request';
    }

    return null;
}

$input = json_decode(file_get_contents('php://input'), true) ?: [];

$action = strtolower(trim((string) ($input['action'] ?? 'submit')));

$organization = trim((string) ($input['organization'] ?? ''));
$contactEmail = trim((string) ($input['contact_email'] ?? ''));
$phone        = trim((string) ($input['phone'] ?? ''));
$adminName    = trim((string) ($input['admin_name'] ?? ''));
$adminEmail   = trim((string) ($input['admin_email'] ?? ''));
$description  = trim((string) ($input['description'] ?? ''));
$planKey      = strtolower(trim((string) ($input['plan'] ?? 'free')));
$reference    = trim((string) ($input['reference'] ?? ''));

// Server-side price table — must mirror PLANS in index.html.
$PRICES = ['free' => 0, 'pro' => 100, 'ultra' => 300, 'test' => 3];
$NAMES  = ['free' => 'Free', 'pro' => 'Pro', 'ultra' => 'Ultra', 'test' => 'Test'];

if (!isset($PRICES[$planKey])) {
    $planKey = 'free';
}

// The page asks this before opening the payment sheet, so a duplicate address is
// caught before a card is charged.
if ($action === 'check') {
    try {
        foreach (['contact' => $contactEmail, 'admin' => $adminEmail] as $label => $value) {
            if ($value === '') {
                continue;
            }
            if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
                http_response_code(422);
                echo json_encode(['status' => 'error', 'field' => $label, 'message' => "Enter a valid {$label} email."]);
                exit;
            }
            $reason = emailConflict(db(), $value);
            if ($reason !== null) {
                http_response_code(409);
                echo json_encode(['status' => 'error', 'field' => $label, 'message' => "The {$label} email {$value} cannot be used — {$reason}."]);
                exit;
            }
        }
    } catch (PDOException $e) {
        // Database unavailable — do not block the visitor; submit reports the failure.
    }
    echo json_encode(['status' => 'success']);
    exit;
}

if ($organization === '' || !filter_var($contactEmail, FILTER_VALIDATE_EMAIL)) {
    http_response_code(422);
    echo json_encode(['status' => 'error', 'message' => 'A valid organization name and contact email are required.']);
    exit;
}

if ($adminEmail !== '' && !filter_var($adminEmail, FILTER_VALIDATE_EMAIL)) {
    http_response_code(422);
    echo json_encode(['status' => 'error', 'message' => 'Enter a valid admin email.']);
    exit;
}

// A company cannot onboard with an address that already belongs to an account or
// to an earlier request.
try {
    foreach (['contact' => $contactEmail, 'admin' => $adminEmail] as $label => $value) {
        if ($value === '') {
            continue;
        }
        $reason = emailConflict(db(), $value);
        if ($reason !== null) {
            http_response_code(409);
            echo json_encode(['status' => 'error', 'message' => "The {$label} email {$value} cannot be used — {$reason}."]);
            exit;
        }
    }
} catch (PDOException $e) {
    // Database unavailable — fall through; the insert below reports the failure.
}

$price    = $PRICES[$planKey];
$amount   = 0.0;
$currency = 'GHS';
$ref      = null;

// Paid plans must be verified with Paystack before anything is stored.
if ($price > 0) {
    if ($reference === '') {
        http_response_code(402);
        echo json_encode(['status' => 'error', 'message' => 'Payment reference is missing.']);
        exit;
    }

    $payment = verify_paystack($reference);
    if (!$payment['ok']) {
        http_response_code(402);
        echo json_encode(['status' => 'error', 'message' => $payment['message']]);
        exit;
    }
    if ($payment['amount'] + 0.001 < $price) {
        http_response_code(402);
        echo json_encode(['status' => 'error', 'message' => 'The amount paid does not match the selected plan.']);
        exit;
    }

    $amount   = (float) $payment['amount'];
    $currency = (string) $payment['currency'];
    $ref      = (string) $payment['reference'];
}

try {
    $pdo  = db();
    $stmt = $pdo->prepare(
        'INSERT INTO onboarding_requests
            (organization, contact_email, phone, admin_name, admin_email, description,
             plan, plan_name, amount_paid, currency, paystack_ref)
         VALUES (:organization, :contact_email, :phone, :admin_name, :admin_email, :description,
             :plan, :plan_name, :amount_paid, :currency, :paystack_ref)'
    );
    $stmt->execute([
        ':organization'  => $organization,
        ':contact_email' => $contactEmail,
        ':phone'         => $phone ?: null,
        ':admin_name'    => $adminName ?: null,
        ':admin_email'   => $adminEmail ?: null,
        ':description'   => $description ?: null,
        ':plan'          => $planKey,
        ':plan_name'     => $NAMES[$planKey],
        ':amount_paid'   => $amount,
        ':currency'      => $currency,
        ':paystack_ref'  => $ref,
    ]);

    echo json_encode([
        'status'    => 'success',
        'id'        => (int) $pdo->lastInsertId(),
        'plan'      => $NAMES[$planKey],
        'amount'    => $amount,
        'reference' => $ref,
    ]);
} catch (PDOException $e) {
    // Duplicate Paystack reference: the request was already recorded, so treat as success.
    if ($e->getCode() === '23000') {
        echo json_encode(['status' => 'success', 'message' => 'Request already recorded.', 'reference' => $ref]);
        exit;
    }
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'Could not save your request. Please try again.']);
}
