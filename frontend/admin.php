<?php
require_once dirname(__DIR__) . '/api/config.php';
require_once dirname(__DIR__) . '/api/auth_lib.php';

$database = new Database();
$db = $database->getConnection();
$token = getRequestToken();

if (!$token) {
    header('Location: admin-login.html', true, 302);
    exit;
}

$stmt = $db->prepare("SELECT role, user_id FROM sessions WHERE token_hash = ? AND expires_at > NOW() LIMIT 1");
$stmt->execute([hash('sha256', $token)]);
$session = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$session || $session['role'] !== 'admin') {
    header('Location: admin-login.html?denied=1', true, 302);
    exit;
}

$stmt = $db->prepare("SELECT a.id, a.privilege, a.organization_id, o.is_active AS organization_active
    FROM admins a LEFT JOIN organizations o ON o.id = a.organization_id
    WHERE a.id = ? AND COALESCE(a.is_active, 1) = 1 LIMIT 1");
$stmt->execute([$session['user_id']]);
$admin = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$admin) {
    header('Location: admin-login.html?denied=1', true, 302);
    exit;
}

if (($admin['privilege'] ?? '') === 'super_admin') {
    header('Location: admin-login.html?denied=1', true, 302);
    exit;
}

if (empty($admin['organization_id']) || (int)$admin['organization_active'] !== 1) {
    header('Location: admin-login.html?denied=1', true, 302);
    exit;
}

header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
readfile(__DIR__ . '/admin-view.html');
