<?php
require_once dirname(__DIR__) . '/api/config.php';
require_once dirname(__DIR__) . '/api/auth_lib.php';

$database = new Database();
$db = $database->getConnection();
$token = getRequestToken();

if (!$token) {
    header('Location: login.html', true, 302);
    exit;
}

$stmt = $db->prepare("SELECT role, user_id FROM sessions WHERE token_hash = ? AND expires_at > NOW() LIMIT 1");
$stmt->execute([hash('sha256', $token)]);
$session = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$session || $session['role'] !== 'worker') {
    header('Location: login.html?denied=1', true, 302);
    exit;
}

$stmt = $db->prepare("SELECT id FROM workers WHERE id = ? AND COALESCE(is_active, 1) = 1 LIMIT 1");
$stmt->execute([$session['user_id']]);
if (!$stmt->fetch()) {
    header('Location: login.html?denied=1', true, 302);
    exit;
}

header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
readfile(__DIR__ . '/worker-view.html');
