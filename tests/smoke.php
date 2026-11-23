<?php
/**
 * Geo-Lo smoke test.
 *
 * Exercises the parts of the system that are easy to break without noticing:
 * schema migration, organization-scoped login, the geofence punch rules, the
 * reports, and the password reset / forced-change / team flows.
 *
 * It talks to a running server over HTTP and needs a database it can write to,
 * so point it at a local XAMPP or a staging deployment — never at production.
 *
 *   SMOKE_BASE_URL=http://localhost:8080/Geo-lo php tests/smoke.php
 *
 * Every row it creates is prefixed "smoke_" and removed again at the end.
 */

require_once __DIR__ . '/../api/config.php';

$base = rtrim(getenv('SMOKE_BASE_URL') ?: 'http://localhost:8080/Geo-lo', '/');
$db = (new Database())->getConnection();

$passed = 0;
$failed = 0;
$created = ['admins' => [], 'workers' => [], 'orgs' => [], 'locations' => [], 'attendance' => []];

function check($label, $condition, $detail = '')
{
    global $passed, $failed;
    if ($condition) {
        $passed++;
        echo "  PASS  $label\n";
    } else {
        $failed++;
        echo "  FAIL  $label" . ($detail !== '' ? "  -> $detail" : '') . "\n";
    }
}

function request($path, $method = 'GET', $body = null, $token = null)
{
    global $base;
    $ch = curl_init($base . '/api/' . $path);
    $headers = ['Content-Type: application/json'];
    if ($token) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 20,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['status' => $status, 'json' => json_decode((string) $raw, true), 'raw' => (string) $raw];
}

$suffix = substr(bin2hex(random_bytes(4)), 0, 8);
$mark = "smoke_$suffix";

$orgA = "Smoke A $suffix";
$orgB = "Smoke B $suffix";
$db->prepare("INSERT INTO organizations (name, slug, is_active) VALUES (?, ?, 1)")->execute([$orgA, "smoke-a-$suffix"]);
$orgAId = (int) $db->lastInsertId();
$created['orgs'][] = $orgAId;
$db->prepare("INSERT INTO organizations (name, slug, is_active) VALUES (?, ?, 1)")->execute([$orgB, "smoke-b-$suffix"]);
$orgBId = (int) $db->lastInsertId();
$created['orgs'][] = $orgBId;

// orgA has one geofence; orgB has none, so its workers can never punch.
$db->prepare("INSERT INTO locations (organization_id, name, latitude, longitude, radius_meters, is_active) VALUES (?, ?, ?, ?, ?, 1)")
   ->execute([$orgAId, 'Smoke Office', 5.60370000, -0.18700000, 150]);
$created['locations'][] = (int) $db->lastInsertId();

$adminEmail = "{$mark}_admin@example.com";
$adminPass = 'Admin12345';
$db->prepare("INSERT INTO admins (name, email, password_hash, privilege, organization_id, must_change_password, is_active) VALUES (?, ?, ?, 'admin', ?, 0, 1)")
   ->execute(['Smoke Admin', $adminEmail, password_hash($adminPass, PASSWORD_DEFAULT), $orgAId]);
$adminId = (int) $db->lastInsertId();
$created['admins'][] = $adminId;

$insideEmail = "{$mark}_inside@example.com";
$outsideEmail = "{$mark}_outside@example.com";
foreach ([[$orgAId, 'SMK-A', $insideEmail], [$orgBId, 'SMK-B', $outsideEmail]] as $w) {
    $db->prepare("INSERT INTO workers (organization_id, employee_id, name, email, pin_hash, is_active) VALUES (?, ?, ?, ?, ?, 1)")
       ->execute([$w[0], $w[1], 'Smoke Worker', $w[2], password_hash('2468', PASSWORD_DEFAULT)]);
    $created['workers'][] = (int) $db->lastInsertId();
}
$insideWorkerId = $created['workers'][0];

echo "== Schema migration ==\n";
$schemaVersion = $db->query("SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'")->fetchColumn();
check('schema_meta reports the current version', (int) $schemaVersion === GEOLO_SCHEMA_VERSION, "db=$schemaVersion code=" . GEOLO_SCHEMA_VERSION);
foreach (['password_reset_codes', 'login_attempts', 'sessions'] as $table) {
    $found = $db->prepare("SELECT COUNT(1) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?");
    $found->execute([$table]);
    check("table $table exists", (int) $found->fetchColumn() === 1);
}
$col = $db->prepare("SELECT COUNT(1) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'attendance' AND column_name = 'organization_id'");
$col->execute();
check('attendance is organization-scoped', (int) $col->fetchColumn() === 1);
$idx = $db->prepare("SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'workers' AND index_name = 'uniq_org_email'");
$idx->execute();
check('worker email is unique per organization', (int) $idx->fetchColumn() > 0);

echo "\n== Organization-scoped worker login ==\n";
$r = request('auth.php', 'POST', ['email' => $insideEmail, 'pin' => '2468']);
check('login without an organization is refused', $r['status'] === 400, "status {$r['status']} {$r['raw']}");
$r = request('auth.php', 'POST', ['organization' => 'No Such Company', 'email' => $insideEmail, 'pin' => '2468']);
check('unknown organization is refused', $r['status'] === 401, "status {$r['status']} {$r['raw']}");
$r = request('auth.php', 'POST', ['organization' => $orgA, 'email' => $insideEmail, 'pin' => '0000']);
check('wrong PIN is refused', $r['status'] === 401, "status {$r['status']} {$r['raw']}");
$r = request('auth.php', 'POST', ['organization' => $orgA, 'email' => $outsideEmail, 'pin' => '2468']);
check('a worker cannot sign in under another organization', $r['status'] === 401, "status {$r['status']} {$r['raw']}");
$r = request('auth.php', 'POST', ['organization' => $orgA, 'email' => $insideEmail, 'pin' => '2468']);
check('correct organization, email and PIN sign in', $r['status'] === 200, "status {$r['status']} {$r['raw']}");
$insideToken = $r['json']['token'] ?? null;

$r = request('auth.php', 'POST', ['role' => 'admin', 'email' => $adminEmail, 'password' => $adminPass, 'console' => 'org']);
check('organization admin signs in', $r['status'] === 200, "status {$r['status']} {$r['raw']}");
$adminToken = $r['json']['token'] ?? null;

echo "\n== Failed-login throttling ==\n";
// A dedicated identifier keeps this from locking out the accounts used above.
$throttleEmail = "{$mark}_throttle@example.com";
$statuses = [];
for ($i = 0; $i < 6; $i++) {
    $statuses[] = request('auth.php', 'POST', ['role' => 'admin', 'email' => $throttleEmail, 'password' => 'nope-nope'] + ['console' => 'org'])['status'];
}
check('the first five bad attempts are reported as bad credentials', $statuses[4] === 401, implode(',', $statuses));
check('the sixth attempt is blocked with 429', $statuses[5] === 429, implode(',', $statuses));

echo "\n== Geofenced punches ==\n";
$r = request('auth.php', 'POST', ['organization' => $orgB, 'email' => $outsideEmail, 'pin' => '2468']);
$outsideToken = $r['json']['token'] ?? null;
check('worker in an organization with no work site can sign in', $r['status'] === 200, "status {$r['status']} {$r['raw']}");

$r = request('attendance.php', 'POST', ['action' => 'checkin', 'latitude' => 5.6037, 'longitude' => -0.1870], $outsideToken);
check('check-in without any work site is refused', $r['status'] === 400, "status {$r['status']} {$r['raw']}");

$r = request('attendance.php', 'POST', ['action' => 'checkin', 'latitude' => 5.6300, 'longitude' => -0.1870, 'accuracy' => 8], $insideToken);
check('check-in far from the work site is refused', $r['status'] === 400 && stripos($r['raw'], 'outside') !== false, "status {$r['status']} {$r['raw']}");

$r = request('attendance.php', 'POST', ['action' => 'checkin', 'latitude' => 5.6037, 'longitude' => -0.1870, 'accuracy' => 8], $insideToken);
check('check-in inside the work site succeeds', $r['status'] === 200 && !empty($r['json']['success']), "status {$r['status']} {$r['raw']}");

$r = request('attendance.php', 'POST', ['action' => 'checkin', 'latitude' => 5.6037, 'longitude' => -0.1870, 'accuracy' => 8], $insideToken);
check('a second check-in while one is open is refused', $r['status'] === 400, "status {$r['status']} {$r['raw']}");

$r = request('attendance.php', 'POST', ['action' => 'checkout', 'latitude' => 5.6037, 'longitude' => -0.1870, 'accuracy' => 8], $insideToken);
check('check-out inside the work site succeeds', $r['status'] === 200, "status {$r['status']} {$r['raw']}");

$attendanceId = (int) $db->query("SELECT id FROM attendance WHERE worker_id = $insideWorkerId ORDER BY id DESC LIMIT 1")->fetchColumn();
$created['attendance'][] = $attendanceId;
$orgOnRow = (int) $db->query("SELECT organization_id FROM attendance WHERE id = $attendanceId")->fetchColumn();
check('the punch is stored against the worker organization', $orgOnRow === $orgAId, "org=$orgOnRow");

echo "\n== Reports ==\n";
$r = request('reports.php?type=daily');
check('reports require a session', $r['status'] === 401, "status {$r['status']} {$r['raw']}");

$r = request('reports.php?type=summary&month=' . date('Y-m'), 'GET', null, $insideToken);
check('worker gets their monthly summary', $r['status'] === 200 && isset($r['json']['worked_days']), "status {$r['status']} {$r['raw']}");
check('the punch just made is counted', (int) ($r['json']['worked_days'] ?? 0) >= 1, $r['raw']);

$r = request("reports.php?type=monthly&worker_id=$insideWorkerId&month=" . date('Y-m'), 'GET', null, $adminToken);
check('admin gets a worker monthly report', $r['status'] === 200 && is_array($r['json']), "status {$r['status']} {$r['raw']}");

$r = request('reports.php?type=monthly&worker_id=' . $created['workers'][1] . '&month=' . date('Y-m'), 'GET', null, $adminToken);
check('admin cannot read another organization\'s worker', $r['status'] === 404, "status {$r['status']} {$r['raw']}");

echo "\n== Password reset ==\n";
$r = request('password_reset.php', 'POST', ['action' => 'request', 'email' => $adminEmail]);
check('reset code request is accepted', $r['status'] === 200, "status {$r['status']} {$r['raw']}");
$codeRow = $db->query("SELECT id, code_hash FROM password_reset_codes WHERE email = " . $db->quote($adminEmail) . " AND used = 0 ORDER BY id DESC LIMIT 1")->fetch(PDO::FETCH_ASSOC);
check('code is stored hashed', $codeRow && strlen($codeRow['code_hash']) > 50);

// Pin the emailed code so the confirm step can be exercised without the inbox.
$db->prepare("UPDATE password_reset_codes SET code_hash = ? WHERE id = ?")
   ->execute([password_hash('135791', PASSWORD_DEFAULT), $codeRow['id']]);
$r = request('password_reset.php', 'POST', ['action' => 'confirm', 'email' => $adminEmail, 'code' => '000000', 'new_password' => 'Reset12345']);
check('a wrong code is rejected', $r['status'] === 400, "status {$r['status']} {$r['raw']}");
$r = request('password_reset.php', 'POST', ['action' => 'confirm', 'email' => $adminEmail, 'code' => '135791', 'new_password' => 'Reset12345']);
check('the right code sets the new password', $r['status'] === 200, "status {$r['status']} {$r['raw']}");
$hash = $db->query("SELECT password_hash FROM admins WHERE id = $adminId")->fetchColumn();
check('new password is stored', password_verify('Reset12345', $hash));
check('reset ends existing sessions', (int) $db->query("SELECT COUNT(1) FROM sessions WHERE role = 'admin' AND user_id = $adminId")->fetchColumn() === 0);
$adminToken = null;

echo "\n== Forced password change and team management ==\n";
$db->prepare("UPDATE admins SET must_change_password = 1 WHERE id = ?")->execute([$adminId]);
$r = request('auth.php', 'POST', ['role' => 'admin', 'email' => $adminEmail, 'password' => 'Reset12345', 'console' => 'org']);
check('admin signs in on an issued password', $r['status'] === 200, "status {$r['status']} {$r['raw']}");
check('the response asks for a password change', !empty($r['json']['user']['must_change_password']), $r['raw']);
$adminToken = $r['json']['token'] ?? null;

$r = request('auth.php', 'PUT', ['action' => 'password', 'new_password' => 'Chosen54321'], $adminToken);
check('an issued password can be replaced without the old one', $r['status'] === 200, "status {$r['status']} {$r['raw']}");
check('the forced-change flag is cleared', (int) $db->query("SELECT must_change_password FROM admins WHERE id = $adminId")->fetchColumn() === 0);

$r = request('admins.php', 'GET', null, $adminToken);
check('team list is readable', $r['status'] === 200 && is_array($r['json']), "status {$r['status']} {$r['raw']}");

$memberEmail = "{$mark}_member@example.com";
$r = request('admins.php', 'POST', ['name' => 'Smoke Member', 'email' => $memberEmail, 'password' => 'Member12345'], $adminToken);
check('a portal user can be added', $r['status'] === 201, "status {$r['status']} {$r['raw']}");
$memberId = (int) ($r['json']['id'] ?? 0);
if ($memberId) {
    $created['admins'][] = $memberId;
}
check('the new user is scoped to the admin organization', (int) $db->query("SELECT organization_id FROM admins WHERE id = $memberId")->fetchColumn() === $orgAId);

$r = request('admins.php', 'POST', ['name' => 'Dupe', 'email' => $memberEmail, 'password' => 'Member12345'], $adminToken);
check('a duplicate teammate email is refused', $r['status'] === 409, "status {$r['status']} {$r['raw']}");

$r = request('admins.php', 'DELETE', ['id' => $adminId], $adminToken);
check('an admin cannot remove themselves', $r['status'] === 400, "status {$r['status']} {$r['raw']}");

$r = request('admins.php', 'DELETE', ['id' => $memberId], $adminToken);
check('a portal user can be removed', $r['status'] === 200, "status {$r['status']} {$r['raw']}");

echo "\n== RESULT: $passed passed, $failed failed ==\n";

foreach ($created['admins'] as $id) {
    $db->exec("DELETE FROM sessions WHERE role = 'admin' AND user_id = $id");
    $db->exec("DELETE FROM admins WHERE id = $id");
}
foreach ($created['workers'] as $id) {
    $db->exec("DELETE FROM sessions WHERE role = 'worker' AND user_id = $id");
    $db->exec("DELETE FROM attendance WHERE worker_id = $id");
    $db->exec("DELETE FROM workers WHERE id = $id");
}
$db->exec("DELETE FROM password_reset_codes WHERE email LIKE '{$mark}%'");
$db->exec("DELETE FROM punch_attempts WHERE worker_id IN (" . implode(',', $created['workers'] ?: [0]) . ")");
$db->exec("DELETE FROM alerts WHERE organization_id IN (" . implode(',', $created['orgs']) . ")");
$db->exec("DELETE FROM audit_log WHERE organization_id IN (" . implode(',', $created['orgs']) . ")");
$db->exec("DELETE FROM locations WHERE organization_id IN (" . implode(',', $created['orgs']) . ")");
$db->exec("DELETE FROM organizations WHERE id IN (" . implode(',', $created['orgs']) . ")");
$db->exec("DELETE FROM login_attempts WHERE identifier LIKE '{$mark}%'");
echo "cleanup done\n";

exit($failed === 0 ? 0 : 1);
