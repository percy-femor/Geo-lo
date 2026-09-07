<?php
require_once 'config.php';
require_once 'auth_lib.php';
require_once 'work_rules.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

try {
    $session = requireOrgAdmin($db);
    $oid = orgId($session);
    autoCloseMissedCheckouts($db, null, $oid);
    refreshAbsenceAlerts($db, null, $oid);

    if ($method === 'GET') {
        $unread = isset($_GET['unread']) && $_GET['unread'] === '1';
        $sql = "SELECT a.*, w.name AS worker_name FROM alerts a LEFT JOIN workers w ON w.id = a.worker_id WHERE a.organization_id = ?";
        $params = [$oid];
        if ($unread) $sql .= " AND a.is_read = 0";
        $sql .= " ORDER BY a.created_at DESC LIMIT 100";
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $countStmt = $db->prepare("SELECT COUNT(*) FROM alerts WHERE is_read = 0 AND organization_id = ?");
        $countStmt->execute([$oid]);
        sendResponse(["alerts" => $rows, "unread" => (int)$countStmt->fetchColumn()]);
    }

    if ($method === 'PUT') {
        $data = getJsonInput() ?: [];
        if (!empty($data['id'])) {
            $db->prepare("UPDATE alerts SET is_read = 1 WHERE id = ? AND organization_id = ?")->execute([$data['id'], $oid]);
        } else {
            $db->prepare("UPDATE alerts SET is_read = 1 WHERE organization_id = ?")->execute([$oid]);
        }
        sendResponse(["message" => "Alerts updated"]);
    }

    sendResponse(["error" => "Method not allowed"], 405);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
