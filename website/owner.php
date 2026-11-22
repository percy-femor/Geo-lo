<?php
require_once dirname(__DIR__) . '/api/config.php';
require_once dirname(__DIR__) . '/api/auth_lib.php';

/** Where the app lives from here: /frontend/ under XAMPP, /app/ once deployed. */
function appUrl(string $file): string
{
    $script = $_SERVER['SCRIPT_NAME'] ?? '';
    $i = strpos($script, '/website/');
    return $i !== false ? substr($script, 0, $i) . '/frontend/' . $file : '/app/' . $file;
}

$database = new Database();
$db = $database->getConnection();
$token = getRequestToken();

if (!$token) {
    header('Location: owner-login.html', true, 302);
    exit;
}

$stmt = $db->prepare("SELECT role, user_id FROM sessions WHERE token_hash = ? AND expires_at > NOW() LIMIT 1");
$stmt->execute([hash('sha256', $token)]);
$session = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$session || $session['role'] !== 'admin') {
    header('Location: owner-login.html?denied=1', true, 302);
    exit;
}

$stmt = $db->prepare("SELECT a.id, a.name, a.email, a.privilege, a.is_active, a.organization_id, a.must_change_password
    FROM admins a WHERE a.id = ? AND COALESCE(a.is_active, 1) = 1 LIMIT 1");
$stmt->execute([$session['user_id']]);
$admin = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$admin || ($admin['privilege'] ?? '') !== 'super_admin') {
    header('Location: ' . appUrl('admin.php'), true, 302);
    exit;
}

// Still on an issued/default password: make them set their own before the console opens.
if (!empty($admin['must_change_password'])) {
    header('Location: ' . appUrl('set-password.html'), true, 302);
    exit;
}

$user = publicAdminUser($admin);

header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
serveHtmlWithBoot(__DIR__ . '/owner-view.html', [
    'role' => 'admin',
    'privilege' => $user['privilege'],
    'user' => $user
]);
