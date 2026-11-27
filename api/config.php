<?php
function loadDotEnv($path) {
    if (!is_readable($path)) return;
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$lines) return;
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || strpos($line, '#') === 0 || strpos($line, '=') === false) continue;
        list($key, $value) = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value);
        $value = trim($value, "\"'");
        if ($key === '') continue;
        if (getenv($key) === false || getenv($key) === '') {
            putenv($key . '=' . $value);
            $_ENV[$key] = $value;
        }
    }
}
loadDotEnv(dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env');

// Shifts are wall-clock times, so the app has to compute "now" in one agreed zone.
// APP_TIMEZONE defaults to UTC; Database::getConnection() pins the MySQL session to
// the same offset so PHP's date() and MySQL's NOW() never disagree about the time.
date_default_timezone_set(getenv('APP_TIMEZONE') ?: 'UTC');

const GEOLO_SCHEMA_VERSION = 2026112401;

function envFlagEnabled($name) {
    $value = strtolower(trim((string)(getenv($name) ?: '')));
    return in_array($value, ['1', 'true', 'yes', 'on'], true);
}

/**
 * Send one transactional email through Resend (https://resend.com).
 * Returns false when no API key is configured so callers can degrade gracefully.
 */
function geoloSendMail($to, $subject, $html) {
    $key  = trim((string)(getenv('RESEND_API_KEY') ?: ''));
    $from = trim((string)(getenv('MAIL_FROM') ?: ''));
    if ($from === '') $from = 'Geo-Lo <onboarding@resend.dev>';
    if ($key === '') {
        error_log('geoloSendMail: RESEND_API_KEY is not set — mail not sent to ' . $to);
        return false;
    }
    if (!function_exists('curl_init')) {
        error_log('geoloSendMail: the PHP curl extension is missing — mail not sent to ' . $to);
        return false;
    }

    $ch = curl_init('https://api.resend.com/emails');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode([
            'from'    => $from,
            'to'      => [$to],
            'subject' => $subject,
            'html'    => $html,
        ]),
        CURLOPT_HTTPHEADER     => [
            'Authorization: Bearer ' . $key,
            'Content-Type: application/json',
        ],
        CURLOPT_TIMEOUT        => 20,
    ]);
    $response = curl_exec($ch);
    $code     = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($response === false || $code < 200 || $code >= 300) {
        error_log('geoloSendMail: Resend rejected the message for ' . $to . ' — HTTP ' . $code . ' ' . (string)$response);
        return false;
    }
    return true;
}

/**
 * True only when APP_ENV marks the deployment as production. Used to disable
 * development conveniences (e.g. returning password-reset tokens in API responses).
 */
function isProductionEnvironment() {
    $env = strtolower(trim((string)(getenv('APP_ENV') ?: '')));
    return in_array($env, ['production', 'prod'], true);
}

function pdoMysqlOptions() {
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    if (!envFlagEnabled('DB_SSL')) {
        return $options;
    }
    $ca = trim((string)(getenv('DB_SSL_CA') ?: ''));
    if ($ca === '') {
        $ca = '/etc/ssl/certs/ca-certificates.crt';
    }
    if (is_readable($ca)) {
        $options[PDO::MYSQL_ATTR_SSL_CA] = $ca;
        $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = true;
    } else {
        $options[PDO::MYSQL_ATTR_SSL_CA] = '';
        $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = false;
    }
    return $options;
}

class Database {
    private $host;
    private $port;
    private $db_name;
    private $username;
    private $password;
    public $conn;

    public function __construct() {
        $this->host = getenv('DB_HOST') ?: 'localhost';
        $this->port = getenv('DB_PORT') ?: '3306';
        $this->db_name = getenv('DB_NAME') ?: 'geo_lo';
        $this->username = getenv('DB_USER') ?: 'root';
        $this->password = getenv('DB_PASSWORD') !== false && getenv('DB_PASSWORD') !== '' ? getenv('DB_PASSWORD') : '';
    }

    public function getConnection() {
        $this->conn = null;
        try {
            $dsn = "mysql:host={$this->host};port={$this->port};dbname={$this->db_name};charset=utf8mb4";
            $this->conn = new PDO($dsn, $this->username, $this->password, pdoMysqlOptions());
            $this->conn->exec("set names utf8mb4");
            // Keep MySQL's clock in step with PHP's APP_TIMEZONE so NOW() and date()
            // never disagree about the current time.
            $this->conn->exec("SET time_zone = '" . date('P') . "'");
            $this->conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            ensureGeoLoSchema($this->conn);
        } catch(PDOException $exception) {
            http_response_code(500);
            echo json_encode(["error" => "Database connection failed"]);
            exit();
        }
        return $this->conn;
    }
}

// Enhanced CORS headers
header('Content-Type: application/json');

// Get the origin of the request
function publicAppOrigin() {
    $forwarded = strtolower(trim(explode(',', $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')[0]));
    $https = $forwarded === 'https'
        || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    $host = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? 'localhost';
    $host = trim(explode(',', $host)[0]);
    return ($https ? 'https' : 'http') . '://' . $host;
}

$allowed_origins = [
    'http://localhost:8080',
    'http://localhost',
    'http://127.0.0.1:8080',
    'http://127.0.0.1'
];
$appUrl = rtrim(getenv('APP_URL') ?: getenv('RENDER_EXTERNAL_URL') ?: '', '/');
if ($appUrl !== '') {
    $allowed_origins[] = $appUrl;
}
$allowed_origins[] = publicAppOrigin();

$http_origin = $_SERVER['HTTP_ORIGIN'] ?? '';

if (in_array($http_origin, $allowed_origins, true)) {
    header("Access-Control-Allow-Origin: $http_origin");
} elseif ($appUrl !== '') {
    header("Access-Control-Allow-Origin: $appUrl");
} else {
    header("Access-Control-Allow-Origin: http://localhost:8080");
}

header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, X-Auth-Token');
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Max-Age: 86400'); // 24 hours

// Handle preflight OPTIONS request
if ($_SERVER['REQUEST_METHOD'] == 'OPTIONS') {
    if (isset($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_METHOD'])) {
        header("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS");
    }
    if (isset($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_HEADERS'])) {
        header("Access-Control-Allow-Headers: {$_SERVER['HTTP_ACCESS_CONTROL_REQUEST_HEADERS']}");
    }
    exit(0);
}

// Calculate distance between two coordinates
function calculateDistance($lat1, $lon1, $lat2, $lon2) {
    $earthRadius = 6371000; // meters
    
    $latFrom = deg2rad($lat1);
    $lonFrom = deg2rad($lon1);
    $latTo = deg2rad($lat2);
    $lonTo = deg2rad($lon2);
    
    $latDelta = $latTo - $latFrom;
    $lonDelta = $lonTo - $lonFrom;
    
    $angle = 2 * asin(sqrt(pow(sin($latDelta / 2), 2) + 
        cos($latFrom) * cos($latTo) * pow(sin($lonDelta / 2), 2)));
    
    return $angle * $earthRadius;
}

// Decode a stored polygon (JSON text or array) into a list of ['lat' => float, 'lng' => float].
// Returns null when there are fewer than 3 valid points.
function decodeLocationPolygon($value) {
    if (empty($value)) return null;
    $decoded = is_array($value) ? $value : json_decode((string)$value, true);
    if (!is_array($decoded)) return null;
    $points = [];
    foreach ($decoded as $point) {
        if (!is_array($point) || !isset($point['lat'], $point['lng'])) continue;
        if (!is_numeric($point['lat']) || !is_numeric($point['lng'])) continue;
        $points[] = ['lat' => (float)$point['lat'], 'lng' => (float)$point['lng']];
    }
    return count($points) >= 3 ? $points : null;
}

// Approximate area of a polygon in square meters (local equirectangular projection).
function polygonAreaSquareMeters($polygon) {
    $n = count($polygon);
    if ($n < 3) return 0.0;
    $rad = M_PI / 180.0;
    $earth = 6371000.0;
    $latSum = 0.0;
    foreach ($polygon as $point) { $latSum += (float)$point['lat']; }
    $cos = cos(($latSum / $n) * $rad);
    $x = [];
    $y = [];
    foreach ($polygon as $point) {
        $x[] = (float)$point['lng'] * $rad * $cos * $earth;
        $y[] = (float)$point['lat'] * $rad * $earth;
    }
    $area = 0.0;
    for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
        $area += ($x[$j] * $y[$i]) - ($x[$i] * $y[$j]);
    }
    return abs($area) / 2.0;
}

// Validate polygon input from a request. Returns:
//   null  -> no polygon supplied
//   array -> normalized polygon with at least $minPoints points and a real area
//   false -> polygon supplied but invalid (too few / malformed / overlapping points)
function normalizeLocationPolygon($value, $minPoints = 4) {
    if ($value === null || $value === '' || $value === []) return null;
    $decoded = is_array($value) ? $value : json_decode((string)$value, true);
    if (!is_array($decoded)) return false;
    $points = [];
    foreach ($decoded as $point) {
        if (!is_array($point) || !isset($point['lat'], $point['lng'])) return false;
        if (!is_numeric($point['lat']) || !is_numeric($point['lng'])) return false;
        $lat = (float)$point['lat'];
        $lng = (float)$point['lng'];
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) return false;
        $points[] = ['lat' => round($lat, 8), 'lng' => round($lng, 8)];
    }
    if (count($points) < $minPoints) return false;
    // Reject degenerate polygons (identical or collinear points) that enclose no real area.
    if (polygonAreaSquareMeters($points) < 1.0) return false;
    return $points;
}

// Simple average centroid of a polygon, used as the location center point.
function polygonCentroid($polygon) {
    $count = count($polygon);
    if ($count === 0) return ['lat' => 0.0, 'lng' => 0.0];
    $lat = 0.0;
    $lng = 0.0;
    foreach ($polygon as $point) {
        $lat += (float)$point['lat'];
        $lng += (float)$point['lng'];
    }
    return ['lat' => $lat / $count, 'lng' => $lng / $count];
}

// Ray-casting point-in-polygon test.
function geoPointInPolygon($lat, $lng, $polygon) {
    $n = count($polygon);
    if ($n < 3) return false;
    $inside = false;
    for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
        $yi = (float)$polygon[$i]['lat'];
        $xi = (float)$polygon[$i]['lng'];
        $yj = (float)$polygon[$j]['lat'];
        $xj = (float)$polygon[$j]['lng'];
        $denom = ($yj - $yi);
        if (abs($denom) < 1e-12) $denom = 1e-12;
        if ((($yi > $lat) !== ($yj > $lat)) && ($lng < ($xj - $xi) * ($lat - $yi) / $denom + $xi)) {
            $inside = !$inside;
        }
    }
    return $inside;
}

// Minimum distance (meters) from a point to a polygon edge (or vertex).
function geoDistanceToPolygon($lat, $lng, $polygon) {
    $n = count($polygon);
    if ($n === 0) return null;
    if ($n < 3) {
        $min = null;
        foreach ($polygon as $point) {
            $d = calculateDistance($lat, $lng, $point['lat'], $point['lng']);
            if ($min === null || $d < $min) $min = $d;
        }
        return $min;
    }
    $min = null;
    for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
        $d = geoPointToSegmentMeters($lat, $lng, $polygon[$j]['lat'], $polygon[$j]['lng'], $polygon[$i]['lat'], $polygon[$i]['lng']);
        if ($min === null || $d < $min) $min = $d;
    }
    return $min;
}

// Distance (meters) from a point to a line segment using a local flat projection.
function geoPointToSegmentMeters($plat, $plng, $alat, $alng, $blat, $blng) {
    $rad = M_PI / 180.0;
    $earth = 6371000.0;
    $cos = cos($plat * $rad);
    $px = $plng * $rad * $cos * $earth;
    $py = $plat * $rad * $earth;
    $ax = $alng * $rad * $cos * $earth;
    $ay = $alat * $rad * $earth;
    $bx = $blng * $rad * $cos * $earth;
    $by = $blat * $rad * $earth;
    $dx = $bx - $ax;
    $dy = $by - $ay;
    $len2 = $dx * $dx + $dy * $dy;
    if ($len2 <= 0) return calculateDistance($plat, $plng, $alat, $alng);
    $t = (($px - $ax) * $dx + ($py - $ay) * $dy) / $len2;
    $t = max(0.0, min(1.0, $t));
    $cx = $ax + $t * $dx;
    $cy = $ay + $t * $dy;
    return sqrt(($px - $cx) ** 2 + ($py - $cy) ** 2);
}

// Get JSON input
function getJsonInput() {
    $input = file_get_contents('php://input');
    if ($input === false || trim($input) === '') {
        return [];
    }
    $data = json_decode($input, true);
    return is_array($data) ? $data : null;
}

// Send JSON response
function sendResponse($data, $statusCode = 200) {
    http_response_code($statusCode);
    echo json_encode($data);
    exit();
}

function tableExists($db, $table) {
    $stmt = $db->query("SHOW TABLES LIKE " . $db->quote($table));
    return $stmt && $stmt->fetch() ? true : false;
}

function columnExists($db, $table, $column) {
    if (!tableExists($db, $table)) return false;
    $stmt = $db->prepare("SHOW COLUMNS FROM `$table` LIKE ?");
    $stmt->execute([$column]);
    return (bool)$stmt->fetch();
}

function ensureColumn($db, $table, $ddl) {
    try { $db->exec("ALTER TABLE `$table` ADD COLUMN $ddl"); } catch (Exception $e) {}
}

function indexExists($db, $table, $index) {
    if (!tableExists($db, $table)) return false;
    $stmt = $db->prepare("SHOW INDEX FROM `$table` WHERE Key_name = ?");
    $stmt->execute([$index]);
    return (bool)$stmt->fetch();
}

// Add an index/key by name, skipping it when it is already there. Errors are
// swallowed the same way ensureColumn does: the schema version is stamped either
// way, and bumping that version is the retry mechanism.
function ensureIndex($db, $table, $index, $ddl) {
    if (indexExists($db, $table, $index)) return;
    try { $db->exec("ALTER TABLE `$table` ADD $ddl"); } catch (Exception $e) {}
}

function dropIndexIfExists($db, $table, $index) {
    if (!indexExists($db, $table, $index)) return;
    try { $db->exec("ALTER TABLE `$table` DROP INDEX `$index`"); } catch (Exception $e) {}
}

function ensureGeoLoSchema($db) {
    static $done = false;
    if ($done || !$db) return;
    $done = true;

    // Fast path: read the stored version without running any DDL.
    try {
        $stmt = $db->prepare("SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'");
        $stmt->execute();
        $current = $stmt->fetchColumn();
        if ($current !== false && (int)$current === GEOLO_SCHEMA_VERSION) {
            return;
        }
    } catch (Exception $e) {
        // schema_meta is missing on a fresh database — create it and migrate below.
        try {
            $db->exec("CREATE TABLE IF NOT EXISTS schema_meta (meta_key VARCHAR(64) PRIMARY KEY, meta_value VARCHAR(255) NULL)");
        } catch (Exception $e2) {
            return;
        }
    }

    $db->exec("CREATE TABLE IF NOT EXISTS organizations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        slug VARCHAR(80) NULL,
        contact_email VARCHAR(120) NULL,
        phone VARCHAR(30) NULL,
        notes VARCHAR(255) NULL,
        plan VARCHAR(32) NULL,
        plan_name VARCHAR(60) NULL,
        onboarding_request_id INT NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    // Billing plan each organization signed up for, plus the website request it
    // was created from (see website/save-request.php).
    foreach ([
        "plan VARCHAR(32) NULL",
        "plan_name VARCHAR(60) NULL",
        "onboarding_request_id INT NULL"
    ] as $col) {
        $name = explode(' ', $col)[0];
        if (!columnExists($db, 'organizations', $name)) ensureColumn($db, 'organizations', $col);
    }

    // Companies that came through the "Get Started" form on the marketing site.
    // The Geo-Lo owner registers each organization from one of these rows.
    $db->exec("CREATE TABLE IF NOT EXISTS onboarding_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization VARCHAR(190) NOT NULL,
        contact_email VARCHAR(190) NOT NULL,
        phone VARCHAR(60) DEFAULT NULL,
        admin_name VARCHAR(190) DEFAULT NULL,
        admin_email VARCHAR(190) DEFAULT NULL,
        description TEXT,
        plan VARCHAR(32) NOT NULL DEFAULT 'free',
        plan_name VARCHAR(60) NOT NULL DEFAULT 'Free',
        amount_paid DECIMAL(10,2) NOT NULL DEFAULT 0,
        currency VARCHAR(8) NOT NULL DEFAULT 'GHS',
        paystack_ref VARCHAR(128) DEFAULT NULL,
        status ENUM('new','contacted','onboarded') NOT NULL DEFAULT 'new',
        organization_id INT NULL,
        email_sent_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_paystack_ref (paystack_ref)
    )");

    if (!columnExists($db, 'onboarding_requests', 'organization_id')) {
        ensureColumn($db, 'onboarding_requests', "organization_id INT NULL");
    }

    $db->exec("CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        privilege VARCHAR(20) NOT NULL DEFAULT 'admin',
        organization_id INT NULL,
        recovery_email VARCHAR(190) NULL,
        must_change_password TINYINT(1) NOT NULL DEFAULT 0,
        password_changed_at DATETIME NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    // Accounts still holding a password somebody else chose (the seeded owner, or an
    // admin created by the owner / an org admin) must set their own before going on.
    // recovery_email exists because the owner signs in as boss@geo-lo, not a real inbox.
    foreach ([
        "recovery_email VARCHAR(190) NULL",
        "must_change_password TINYINT(1) NOT NULL DEFAULT 0",
        "password_changed_at DATETIME NULL"
    ] as $col) {
        $name = explode(' ', $col)[0];
        if (!columnExists($db, 'admins', $name)) ensureColumn($db, 'admins', $col);
    }

    // One-time codes emailed to any account type (worker, org admin, owner) that asks
    // for a password/PIN reset. Supersedes the worker-only password_resets table.
    $db->exec("CREATE TABLE IF NOT EXISTS password_reset_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_type VARCHAR(16) NOT NULL,
        account_id INT NOT NULL,
        email VARCHAR(190) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        used TINYINT(1) NOT NULL DEFAULT 0,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_account (account_type, account_id)
    )");

    if (tableExists($db, 'password_resets')) {
        $db->exec("DROP TABLE IF EXISTS password_resets");
    }

    $db->exec("CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        role ENUM('admin','worker') NOT NULL,
        user_id INT NOT NULL,
        device_fingerprint VARCHAR(128) NULL,
        expires_at DATETIME NOT NULL,
        last_seen DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    $db->exec("CREATE TABLE IF NOT EXISTS shifts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        work_days VARCHAR(32) NOT NULL DEFAULT '1,2,3,4,5',
        late_grace_minutes INT DEFAULT 10,
        overtime_after_minutes INT DEFAULT 0,
        break_minutes INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    $db->exec("CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        actor_role VARCHAR(20) NOT NULL,
        actor_id INT NULL,
        organization_id INT NULL,
        action VARCHAR(80) NOT NULL,
        entity VARCHAR(50) NOT NULL,
        entity_id INT NULL,
        details TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    $db->exec("CREATE TABLE IF NOT EXISTS alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        worker_id INT NULL,
        attendance_id INT NULL,
        organization_id INT NULL,
        message VARCHAR(255) NOT NULL,
        is_read TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    // A worker's face is stored as a 128-value embedding computed in the browser by
    // face-api.js (see frontend/face.js) and sent here as JSON. phash is the retired
    // 64-bit average hash: kept so rows written by the old scheme still load, but it is
    // no longer produced and must accept NULL.
    $db->exec("CREATE TABLE IF NOT EXISTS worker_faces (
        id INT AUTO_INCREMENT PRIMARY KEY,
        worker_id INT NOT NULL,
        phash VARCHAR(128) NULL,
        descriptor TEXT NULL,
        engine VARCHAR(32) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    foreach ([
        "descriptor TEXT NULL",
        "engine VARCHAR(32) NULL"
    ] as $col) {
        $name = explode(' ', $col)[0];
        if (!columnExists($db, 'worker_faces', $name)) ensureColumn($db, 'worker_faces', $col);
    }
    // Databases created before descriptors existed have phash declared NOT NULL, which
    // would reject an insert that only carries a descriptor.
    try { $db->exec("ALTER TABLE worker_faces MODIFY phash VARCHAR(128) NULL"); } catch (Exception $e) {}

    // The step between "credentials accepted" and "session issued". A worker login no
    // longer returns a session straight away: it returns one of these challenge tokens,
    // and the session is only created once the face check (enroll on first login, verify
    // afterwards) passes.
    $db->exec("CREATE TABLE IF NOT EXISTS login_challenges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        role ENUM('admin','worker') NOT NULL,
        user_id INT NOT NULL,
        purpose VARCHAR(24) NOT NULL DEFAULT 'login_face',
        device_fingerprint VARCHAR(128) NULL,
        attempts INT NOT NULL DEFAULT 0,
        consumed TINYINT(1) NOT NULL DEFAULT 0,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_login_challenges_user (role, user_id)
    )");

    $db->exec("CREATE TABLE IF NOT EXISTS punch_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        worker_id INT NULL,
        action VARCHAR(20) NULL,
        latitude DECIMAL(10,8) NULL,
        longitude DECIMAL(11,8) NULL,
        accuracy_meters INT NULL,
        success TINYINT(1) DEFAULT 0,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");

    foreach ([
        "shift_id INT NULL",
        "assigned_location_id INT NULL",
        "device_fingerprint VARCHAR(128) NULL",
        "device_bound TINYINT(1) DEFAULT 0",
        "require_face TINYINT(1) DEFAULT 0",
        "organization_id INT NULL"
    ] as $col) {
        $name = explode(' ', $col)[0];
        if (!columnExists($db, 'workers', $name)) ensureColumn($db, 'workers', $col);
    }

    if (tableExists($db, 'locations') && !columnExists($db, 'locations', 'organization_id')) {
        ensureColumn($db, 'locations', "organization_id INT NULL");
    }
    if (tableExists($db, 'locations') && !columnExists($db, 'locations', 'polygon')) {
        ensureColumn($db, 'locations', "polygon TEXT NULL");
    }
    if (tableExists($db, 'shifts') && !columnExists($db, 'shifts', 'organization_id')) {
        ensureColumn($db, 'shifts', "organization_id INT NULL");
    }
    if (tableExists($db, 'admins') && !columnExists($db, 'admins', 'organization_id')) {
        ensureColumn($db, 'admins', "organization_id INT NULL");
    }
    if (tableExists($db, 'audit_log') && !columnExists($db, 'audit_log', 'organization_id')) {
        ensureColumn($db, 'audit_log', "organization_id INT NULL");
    }
    if (tableExists($db, 'alerts') && !columnExists($db, 'alerts', 'organization_id')) {
        ensureColumn($db, 'alerts', "organization_id INT NULL");
    }

    foreach ([
        "overtime_minutes INT DEFAULT 0",
        "notes VARCHAR(255) NULL",
        "is_manual TINYINT(1) DEFAULT 0",
        "outside_geofence TINYINT(1) DEFAULT 0",
        "missed_checkout TINYINT(1) DEFAULT 0",
        "corrected_by INT NULL",
        "accuracy_meters INT NULL",
        "device_fingerprint VARCHAR(128) NULL"
    ] as $col) {
        $name = explode(' ', $col)[0];
        if (tableExists($db, 'attendance') && !columnExists($db, 'attendance', $name)) {
            ensureColumn($db, 'attendance', $col);
        }
    }

    if (tableExists($db, 'admins') && !columnExists($db, 'admins', 'privilege')) {
        ensureColumn($db, 'admins', "privilege VARCHAR(20) NOT NULL DEFAULT 'admin'");
    }

    $ownerEmail = 'boss@geo-lo';
    // The first owner password is never a constant in the source. It comes from
    // OWNER_PASSWORD, and a random one is used when that is unset — in which case the
    // owner recovers access through OWNER_RECOVERY_EMAIL. must_change_password still
    // forces a change on the first console login either way.
    $ownerPassword = trim((string)(getenv('OWNER_PASSWORD') ?: ''));
    if ($ownerPassword === '') {
        $ownerPassword = bin2hex(random_bytes(12));
    }
    // boss@geo-lo is a login name, not a deliverable inbox, so owner reset codes go here.
    $ownerRecoveryEmail = trim((string)(getenv('OWNER_RECOVERY_EMAIL') ?: ''));
    $count = (int)$db->query("SELECT COUNT(*) FROM admins")->fetchColumn();
    if ($count === 0) {
        $stmt = $db->prepare("INSERT INTO admins (name, email, password_hash, privilege, recovery_email, must_change_password, organization_id) VALUES (?, ?, ?, ?, ?, 1, NULL)");
        $stmt->execute(['Geo-Lo Owner', $ownerEmail, password_hash($ownerPassword, PASSWORD_DEFAULT), 'super_admin', ($ownerRecoveryEmail !== '' ? $ownerRecoveryEmail : null)]);
    }

    if (columnExists($db, 'admins', 'privilege')) {
        $superCount = (int)$db->query("SELECT COUNT(*) FROM admins WHERE privilege = 'super_admin' AND COALESCE(is_active, 1) = 1")->fetchColumn();
        if ($superCount === 0) {
            $firstId = (int)$db->query("SELECT id FROM admins WHERE COALESCE(is_active, 1) = 1 ORDER BY id ASC LIMIT 1")->fetchColumn();
            if ($firstId) {
                $db->prepare("UPDATE admins SET privilege = 'super_admin', organization_id = NULL WHERE id = ?")->execute([$firstId]);
            }
        }
        $db->exec("UPDATE admins SET organization_id = NULL WHERE privilege = 'super_admin'");

        $owner = $db->query("SELECT id, email, password_hash, name FROM admins WHERE privilege = 'super_admin' AND COALESCE(is_active, 1) = 1 ORDER BY id ASC LIMIT 1")->fetch(PDO::FETCH_ASSOC);
        if ($owner) {
            $currentEmail = strtolower(trim((string)$owner['email']));
            $taken = $db->prepare("SELECT id FROM admins WHERE LOWER(email) = ? AND id <> ? LIMIT 1");
            $taken->execute([$ownerEmail, $owner['id']]);
            $emailFree = !$taken->fetch();
            $legacyPassword = password_verify('Admin@12345', $owner['password_hash']);
            $fields = [];
            $values = [];
            if ($emailFree && $currentEmail !== $ownerEmail) {
                $fields[] = 'email = ?';
                $values[] = $ownerEmail;
                $fields[] = 'password_hash = ?';
                $values[] = password_hash($ownerPassword, PASSWORD_DEFAULT);
            } elseif ($legacyPassword) {
                $fields[] = 'password_hash = ?';
                $values[] = password_hash($ownerPassword, PASSWORD_DEFAULT);
            }
            if (in_array($owner['name'], ['System Admin', 'System A', ''], true) || $currentEmail === 'admin@geolo.local') {
                $fields[] = 'name = ?';
                $values[] = 'Geo-Lo Owner';
            }
            if ($fields) {
                $values[] = $owner['id'];
                $db->prepare("UPDATE admins SET " . implode(', ', $fields) . " WHERE id = ?")->execute($values);
            }
        }
    }

    if (columnExists($db, 'admins', 'recovery_email')) {
        // Only backfill when a recovery address is configured, so an unset value never
        // replaces one that a later deploy could still fill in.
        if ($ownerRecoveryEmail !== '') {
            $db->prepare("UPDATE admins SET recovery_email = ? WHERE privilege = 'super_admin' AND (recovery_email IS NULL OR recovery_email = '')")
                ->execute([$ownerRecoveryEmail]);
        }

        // Any account still holding the seeded/issued password is forced to set its own
        // before the console will let it through.
        $flag = $db->prepare("UPDATE admins SET must_change_password = 1 WHERE id = ?");
        foreach ($db->query("SELECT id, password_hash FROM admins WHERE COALESCE(is_active, 1) = 1")->fetchAll(PDO::FETCH_ASSOC) as $adminRow) {
            if (password_verify($ownerPassword, (string)$adminRow['password_hash'])) {
                $flag->execute([(int)$adminRow['id']]);
            }
        }
    }

    $needsOrg = false;
    if (columnExists($db, 'workers', 'organization_id')) {
        $needsOrg = (int)$db->query("SELECT COUNT(*) FROM workers WHERE organization_id IS NULL")->fetchColumn() > 0;
    }
    if (!$needsOrg && columnExists($db, 'locations', 'organization_id')) {
        $needsOrg = (int)$db->query("SELECT COUNT(*) FROM locations WHERE organization_id IS NULL")->fetchColumn() > 0;
    }
    if ($needsOrg) {
        $orgId = (int)$db->query("SELECT id FROM organizations ORDER BY id ASC LIMIT 1")->fetchColumn();
        if (!$orgId) {
            $db->exec("INSERT INTO organizations (name, slug, notes, is_active) VALUES ('Existing organization', 'existing-organization', 'Migrated from the previous single-tenant workspace', 1)");
            $orgId = (int)$db->lastInsertId();
        }
        if (columnExists($db, 'workers', 'organization_id')) {
            $db->exec("UPDATE workers SET organization_id = $orgId WHERE organization_id IS NULL");
        }
        if (columnExists($db, 'locations', 'organization_id')) {
            $db->exec("UPDATE locations SET organization_id = $orgId WHERE organization_id IS NULL");
        }
        if (columnExists($db, 'shifts', 'organization_id')) {
            $db->exec("UPDATE shifts SET organization_id = $orgId WHERE organization_id IS NULL");
        }
        if (columnExists($db, 'admins', 'organization_id')) {
            $db->exec("UPDATE admins SET organization_id = $orgId WHERE privilege <> 'super_admin' AND organization_id IS NULL");
        }
        if (columnExists($db, 'alerts', 'organization_id')) {
            $db->exec("UPDATE alerts a JOIN workers w ON w.id = a.worker_id SET a.organization_id = w.organization_id WHERE a.organization_id IS NULL");
        }
    }

    if (tableExists($db, 'organizations') && tableExists($db, 'shifts') && columnExists($db, 'shifts', 'organization_id')) {
        $orgs = $db->query("SELECT id FROM organizations")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($orgs as $oid) {
            $oid = (int)$oid;
            $shiftCount = (int)$db->query("SELECT COUNT(*) FROM shifts WHERE organization_id = $oid")->fetchColumn();
            if ($shiftCount === 0) {
                $db->exec("INSERT INTO shifts (name, start_time, end_time, work_days, late_grace_minutes, overtime_after_minutes, break_minutes, organization_id)
                    VALUES ('Standard day', '08:00:00', '17:00:00', '1,2,3,4,5', 10, 0, 60, $oid)");
            }
            $defaultShift = (int)$db->query("SELECT id FROM shifts WHERE organization_id = $oid AND is_active = 1 ORDER BY id ASC LIMIT 1")->fetchColumn();
            if ($defaultShift && columnExists($db, 'workers', 'shift_id')) {
                $db->exec("UPDATE workers SET shift_id = $defaultShift WHERE organization_id = $oid AND shift_id IS NULL");
            }
        }
    }

    // --- Multi-tenant organization layout ---------------------------------------
    // Every tenant table carries organization_id, and uniqueness is scoped to one
    // organization so two organizations can each have their own "EMP-001" or the
    // same worker email. Without this the tables are only nominally multi-tenant:
    // a global UNIQUE on workers.employee_id stops a second organization registering
    // the same short ID at all.

    // Attendance gains a denormalized organization_id (taken from its worker) so
    // reports and exports can filter by organization without always joining workers.
    if (tableExists($db, 'attendance')) {
        if (!columnExists($db, 'attendance', 'organization_id')) {
            ensureColumn($db, 'attendance', "organization_id INT NULL");
        }
        if (columnExists($db, 'attendance', 'organization_id')) {
            try {
                $db->exec("UPDATE attendance a JOIN workers w ON w.id = a.worker_id
                    SET a.organization_id = w.organization_id
                    WHERE a.organization_id IS NULL");
            } catch (Exception $e) {}
        }
    }

    // Replace the legacy global worker rules with per-organization ones.
    if (tableExists($db, 'workers')) {
        dropIndexIfExists($db, 'workers', 'employee_id'); // legacy global UNIQUE
        ensureIndex($db, 'workers', 'uniq_org_employee', 'UNIQUE KEY uniq_org_employee (organization_id, employee_id)');
        ensureIndex($db, 'workers', 'uniq_org_email', 'UNIQUE KEY uniq_org_email (organization_id, email)');
        ensureIndex($db, 'workers', 'idx_workers_org', 'KEY idx_workers_org (organization_id)');
    }

    // A slug is how an organization is looked up by name, so it must be unique.
    ensureIndex($db, 'organizations', 'uniq_org_slug', 'UNIQUE KEY uniq_org_slug (slug)');

    // Scoping indexes so per-organization queries do not full-scan.
    foreach (['locations', 'shifts', 'alerts', 'audit_log', 'attendance'] as $tenantTable) {
        if (tableExists($db, $tenantTable) && columnExists($db, $tenantTable, 'organization_id')) {
            ensureIndex($db, $tenantTable, 'idx_' . $tenantTable . '_org', "KEY idx_{$tenantTable}_org (organization_id)");
        }
    }

    // Failed-login tracking. Worker PINs are short, so both the worker and admin login
    // paths count failures here and lock out temporarily once a threshold is passed.
    if (!tableExists($db, 'login_attempts')) {
        $db->exec("CREATE TABLE login_attempts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            scope VARCHAR(20) NOT NULL,
            identifier VARCHAR(255) NOT NULL,
            ip VARCHAR(45) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_login_attempts_lookup (scope, identifier, created_at),
            KEY idx_login_attempts_ip (ip, created_at)
        )");
    }

    try {
        $db->prepare("INSERT INTO schema_meta (meta_key, meta_value) VALUES ('schema_version', ?)
            ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)")->execute([GEOLO_SCHEMA_VERSION]);
    } catch (Exception $e) {}
}
// Intentionally no closing PHP tag
