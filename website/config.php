<?php
/**
 * Geo-Lo — shared configuration & helpers.
 *
 * Used by verify-payment.php, save-request.php and owner.php.
 *
 * Reads the project-root .env (the same file api/config.php uses) so the
 * marketing site, the API and the owner console share one database and one set
 * of secrets. Web3Forms cannot send mail to third parties (it only delivers
 * submissions to your own inbox), so outbound email to companies is sent
 * through Resend here.
 */
declare(strict_types=1);

/** Minimal .env reader — matches the rules used by api/config.php. */
function loadEnvFile(string $path): void
{
    if (!is_readable($path)) {
        return;
    }
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || strpos($line, '#') === 0 || strpos($line, '=') === false) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $key   = trim($key);
        $value = trim(trim($value), "\"'");
        if ($key === '') {
            continue;
        }
        if (getenv($key) === false || getenv($key) === '') {
            putenv($key . '=' . $value);
            $_ENV[$key] = $value;
        }
    }
}

function envValue(string $key, string $default = ''): string
{
    $value = getenv($key);
    return ($value === false || $value === '') ? $default : (string) $value;
}

loadEnvFile(dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env');

/* ---------- MySQL — the same database the app uses ---------- */
define('DB_HOST', envValue('DB_HOST', '127.0.0.1'));
define('DB_PORT', envValue('DB_PORT', '3306'));
define('DB_NAME', envValue('DB_NAME', 'geo_lo'));
define('DB_USER', envValue('DB_USER', 'root'));
define('DB_PASS', getenv('DB_PASSWORD') !== false ? (string) getenv('DB_PASSWORD') : '');

/* ---------- Paystack (Dashboard > Settings > API Keys & Webhooks) ---------- */
// Only the secret key lives on the server: verify_paystack() uses it to confirm each
// transaction with Paystack's API. The matching public key is public by design and is
// hardcoded in index.html.
define('PAYSTACK_SECRET_KEY', envValue('PAYSTACK_SECRET_KEY'));

/* ---------- Resend (https://resend.com — free tier available) ---------- */
define('RESEND_API_KEY', envValue('RESEND_API_KEY'));
// No-reply sender: the API call sends no Reply-To header, so replies are not
// routed anywhere and the mailbox can stay unmonitored.
// Free tier: keep onboarding@resend.dev. Once your domain is verified, switch
// to something like 'Geo-Lo <no-reply@yourdomain.com>'.
define('MAIL_FROM', envValue('MAIL_FROM', 'Geo-Lo <onboarding@resend.dev>'));

/** TLS options for hosted MySQL (TiDB Cloud, etc.). Mirrors api/config.php. */
function sitePdoOptions(): array
{
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    if (!in_array(strtolower(envValue('DB_SSL')), ['1', 'true', 'yes', 'on'], true)) {
        return $options;
    }
    $ca = envValue('DB_SSL_CA', '/etc/ssl/certs/ca-certificates.crt');
    if (is_readable($ca)) {
        $options[PDO::MYSQL_ATTR_SSL_CA] = $ca;
        $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = true;
    } else {
        $options[PDO::MYSQL_ATTR_SSL_CA] = '';
        $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = false;
    }
    return $options;
}

/**
 * Single PDO connection. Creates the database and table on first use so no
 * manual SQL import is required (the MySQL user needs CREATE privileges).
 */
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $options = sitePdoOptions() + [
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        $options
    );

    try {
        $pdo->exec('CREATE DATABASE IF NOT EXISTS `' . DB_NAME . '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    } catch (PDOException $e) {
        // No CREATE privilege — assume the database already exists.
    }
    $pdo->exec('USE `' . DB_NAME . '`');

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS onboarding_requests (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            organization  VARCHAR(190) NOT NULL,
            contact_email VARCHAR(190) NOT NULL,
            phone         VARCHAR(60)  DEFAULT NULL,
            admin_name    VARCHAR(190) DEFAULT NULL,
            admin_email   VARCHAR(190) DEFAULT NULL,
            description   TEXT,
            plan          VARCHAR(32)  NOT NULL DEFAULT \'free\',
            plan_name     VARCHAR(60)  NOT NULL DEFAULT \'Free\',
            amount_paid   DECIMAL(10,2) NOT NULL DEFAULT 0,
            currency      VARCHAR(8)   NOT NULL DEFAULT \'GHS\',
            paystack_ref  VARCHAR(128) DEFAULT NULL,
            status        ENUM(\'new\',\'contacted\',\'onboarded\') NOT NULL DEFAULT \'new\',
            organization_id INT NULL,
            email_sent_at DATETIME DEFAULT NULL,
            created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_paystack_ref (paystack_ref)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );

    // Databases created before the owner console could register an organization
    // from a request need the link column added.
    try {
        $pdo->exec('ALTER TABLE onboarding_requests ADD COLUMN organization_id INT NULL');
    } catch (PDOException $e) {
        // Column already exists.
    }

    return $pdo;
}

/**
 * Verify a Paystack transaction with Paystack's API (server-side).
 *
 * @return array{ok:bool,message?:string,reference?:string,amount?:float,currency?:string,plan?:?string,channel?:?string}
 */
function verify_paystack(string $reference): array
{
    if (strpos(PAYSTACK_SECRET_KEY, 'xxxxxxxx') !== false) {
        return ['ok' => false, 'message' => 'Paystack secret key is not configured on the server.'];
    }

    $ch = curl_init('https://api.paystack.co/transaction/verify/' . rawurlencode($reference));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . PAYSTACK_SECRET_KEY, 'Cache-Control: no-cache'],
        CURLOPT_TIMEOUT        => 30,
    ]);
    $response = curl_exec($ch);
    $error    = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        return ['ok' => false, 'message' => 'Could not reach Paystack. ' . $error];
    }

    $result = json_decode($response, true);
    if (!$result || ($result['status'] ?? false) !== true || ($result['data']['status'] ?? '') !== 'success') {
        return ['ok' => false, 'message' => 'Payment verification failed at Paystack.'];
    }

    $data = $result['data'];
    return [
        'ok'        => true,
        'reference' => $data['reference'] ?? $reference,
        'amount'    => ((float) ($data['amount'] ?? 0)) / 100,
        'currency'  => $data['currency'] ?? 'GHS',
        'plan'      => $data['metadata']['plan'] ?? null,
        'channel'   => $data['channel'] ?? null,
    ];
}

/**
 * Send an email through the Resend API.
 *
 * @return array{ok:bool,message?:string,id?:string}
 */
function resend_send(string $to, string $subject, string $html): array
{
    if (RESEND_API_KEY === '') {
        return ['ok' => false, 'message' => 'Resend API key is not configured on the server.'];
    }

    $ch = curl_init('https://api.resend.com/emails');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode([
            'from'    => MAIL_FROM,
            'to'      => [$to],
            'subject' => $subject,
            'html'    => $html,
        ]),
        CURLOPT_HTTPHEADER     => [
            'Authorization: Bearer ' . RESEND_API_KEY,
            'Content-Type: application/json',
        ],
        CURLOPT_TIMEOUT        => 30,
    ]);
    $response = curl_exec($ch);
    $code     = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error    = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        return ['ok' => false, 'message' => 'Could not reach Resend. ' . $error];
    }

    $result = json_decode($response, true);
    if ($code >= 200 && $code < 300 && isset($result['id'])) {
        return ['ok' => true, 'id' => (string) $result['id']];
    }

    return ['ok' => false, 'message' => $result['message'] ?? ('Resend error (HTTP ' . $code . ')')];
}
