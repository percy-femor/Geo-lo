<?php
require_once 'config.php';
require_once 'auth_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method === 'GET') {
        $session = requireOrgAdmin($db);
        $stmt = $db->prepare("SELECT * FROM shifts WHERE organization_id = ? ORDER BY start_time, name");
        $stmt->execute([orgId($session)]);
        sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    if ($method === 'POST') {
        $session = requireOrgAdmin($db);
        $data = getJsonInput();
        if (empty($data['name']) || empty($data['start_time']) || empty($data['end_time'])) {
            sendResponse(["error" => "Name, start time, and end time are required"], 400);
        }
        $stmt = $db->prepare("INSERT INTO shifts (name, start_time, end_time, work_days, late_grace_minutes, overtime_after_minutes, break_minutes, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        $stmt->execute([
            $data['name'],
            $data['start_time'],
            $data['end_time'],
            $data['work_days'] ?? '1,2,3,4,5',
            $data['late_grace_minutes'] ?? 10,
            $data['overtime_after_minutes'] ?? 0,
            $data['break_minutes'] ?? 0,
            orgId($session)
        ]);
        writeAudit($db, $session, 'create', 'shift', (int)$db->lastInsertId(), $data);
        sendResponse(["message" => "Shift created"], 201);
    }

    if ($method === 'PUT') {
        $session = requireOrgAdmin($db);
        $data = getJsonInput();
        if (empty($data['id'])) sendResponse(["error" => "Shift ID required"], 400);
        assertOrgRow($db, 'shifts', $data['id'], orgId($session), 'Shift');
        $fields = [];
        $values = [];
        foreach (['name', 'start_time', 'end_time', 'work_days', 'late_grace_minutes', 'overtime_after_minutes', 'break_minutes', 'is_active'] as $field) {
            if (isset($data[$field])) {
                $fields[] = "$field = ?";
                $values[] = $data[$field];
            }
        }
        if (!$fields) sendResponse(["message" => "No fields to update"]);
        $values[] = $data['id'];
        $values[] = orgId($session);
        $db->prepare("UPDATE shifts SET " . implode(', ', $fields) . " WHERE id = ? AND organization_id = ?")->execute($values);
        writeAudit($db, $session, 'update', 'shift', (int)$data['id'], $data);
        sendResponse(["message" => "Shift updated"]);
    }

    if ($method === 'DELETE') {
        $session = requireOrgAdmin($db);
        $oid = orgId($session);
        $data = getJsonInput();
        if (empty($data['id'])) sendResponse(["error" => "Shift ID required"], 400);
        assertOrgRow($db, 'shifts', $data['id'], $oid, 'Shift');
        $countStmt = $db->prepare("SELECT COUNT(*) FROM shifts WHERE organization_id = ?");
        $countStmt->execute([$oid]);
        if ((int)$countStmt->fetchColumn() <= 1) sendResponse(["error" => "Keep at least one shift"], 400);
        $fallbackStmt = $db->prepare("SELECT id FROM shifts WHERE organization_id = ? AND id <> ? ORDER BY id LIMIT 1");
        $fallbackStmt->execute([$oid, $data['id']]);
        $fallback = (int)$fallbackStmt->fetchColumn();
        $db->prepare("UPDATE workers SET shift_id = ? WHERE shift_id = ? AND organization_id = ?")->execute([$fallback, $data['id'], $oid]);
        $db->prepare("DELETE FROM shifts WHERE id = ? AND organization_id = ?")->execute([$data['id'], $oid]);
        writeAudit($db, $session, 'delete', 'shift', (int)$data['id']);
        sendResponse(["message" => "Shift deleted"]);
    }

    sendResponse(["error" => "Method not allowed"], 405);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
