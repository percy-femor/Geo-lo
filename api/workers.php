<?php
require_once 'config.php';
require_once 'auth_lib.php';
require_once 'face_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

try {
    switch ($method) {
        case 'GET':
            $session = requireAuth($db, ['admin', 'worker']);
            if ($session['role'] === 'worker') {
                $stmt = $db->prepare("SELECT id, employee_id, name, email, phone, shift_id FROM workers WHERE id = ? AND COALESCE(is_active, 1) = 1");
                $stmt->execute([$session['user_id']]);
                $me = $stmt->fetch(PDO::FETCH_ASSOC);
                sendResponse($me ? [$me] : []);
            }
            $session = requireOrgAdmin($db);
            $stmt = $db->prepare("SELECT w.id, w.employee_id, w.name, w.email, w.phone, w.is_active, w.created_at, w.shift_id, w.device_bound, w.require_face, s.name AS shift_name
                FROM workers w LEFT JOIN shifts s ON s.id = w.shift_id
                WHERE COALESCE(w.is_active, 1) = 1 AND w.organization_id = ?
                ORDER BY w.name");
            $stmt->execute([orgId($session)]);
            sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));

        case 'POST':
            $session = requireOrgAdmin($db);
            $oid = orgId($session);
            $data = getJsonInput();
            if (!isset($data['employee_id'], $data['name'], $data['email'], $data['pin'], $data['password'])) {
                sendResponse(["error" => "Missing required fields"], 400);
            }
            $dup = $db->prepare("SELECT id FROM workers WHERE organization_id = ? AND employee_id = ? LIMIT 1");
            $dup->execute([$oid, $data['employee_id']]);
            if ($dup->fetch()) sendResponse(["error" => "Employee ID already exists in this organization"], 409);
            $emailDup = $db->prepare("SELECT id FROM workers WHERE email = ? LIMIT 1");
            $emailDup->execute([$data['email']]);
            if ($emailDup->fetch()) sendResponse(["error" => "This email is already used by a worker"], 409);
            $shiftId = $data['shift_id'] ?? null;
            if ($shiftId) assertOrgRow($db, 'shifts', $shiftId, $oid, 'Shift');
            $stmt = $db->prepare("INSERT INTO workers (employee_id, name, email, phone, pin_hash, password_hash, shift_id, require_face, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $data['employee_id'],
                $data['name'],
                $data['email'],
                $data['phone'] ?? null,
                password_hash($data['pin'], PASSWORD_DEFAULT),
                password_hash($data['password'], PASSWORD_DEFAULT),
                $shiftId,
                !empty($data['require_face']) ? 1 : 0,
                $oid
            ]);
            writeAudit($db, $session, 'create', 'worker', (int)$db->lastInsertId(), ['email' => $data['email']]);
            sendResponse(["message" => "Worker registered successfully"], 201);

        case 'PUT':
            $session = requireOrgAdmin($db);
            $oid = orgId($session);
            $data = getJsonInput();
            if (!isset($data['id'])) sendResponse(["error" => "Worker ID required"], 400);
            assertOrgRow($db, 'workers', $data['id'], $oid, 'Worker');

            if (!empty($data['reset_device'])) {
                $db->prepare("UPDATE workers SET device_fingerprint = NULL, device_bound = 0 WHERE id = ? AND organization_id = ?")->execute([$data['id'], $oid]);
                writeAudit($db, $session, 'reset_device', 'worker', (int)$data['id']);
                sendResponse(["message" => "Device binding reset"]);
            }

            $fields = [];
            $values = [];
            foreach (['name' => 'name', 'email' => 'email', 'phone' => 'phone'] as $key => $col) {
                if (isset($data[$key])) { $fields[] = "$col = ?"; $values[] = $data[$key]; }
            }
            if (isset($data['pin'])) { $fields[] = "pin_hash = ?"; $values[] = password_hash($data['pin'], PASSWORD_DEFAULT); }
            if (isset($data['password'])) { $fields[] = "password_hash = ?"; $values[] = password_hash($data['password'], PASSWORD_DEFAULT); }
            if (isset($data['shift_id'])) {
                if ($data['shift_id']) assertOrgRow($db, 'shifts', $data['shift_id'], $oid, 'Shift');
                $fields[] = "shift_id = ?";
                $values[] = $data['shift_id'] ?: null;
            }
            if (isset($data['require_face'])) { $fields[] = "require_face = ?"; $values[] = $data['require_face'] ? 1 : 0; }
            if (empty($fields)) sendResponse(["message" => "No fields to update"]);
            $values[] = $data['id'];
            $values[] = $oid;
            $db->prepare("UPDATE workers SET " . implode(', ', $fields) . " WHERE id = ? AND organization_id = ?")->execute($values);
            writeAudit($db, $session, 'update', 'worker', (int)$data['id']);
            sendResponse(["message" => "Worker updated successfully"]);

        case 'DELETE':
            $session = requireOrgAdmin($db);
            $data = getJsonInput();
            if (!isset($data['id'])) sendResponse(["error" => "Worker ID required"], 400);
            assertOrgRow($db, 'workers', $data['id'], orgId($session), 'Worker');
            $db->prepare("UPDATE workers SET is_active = 0 WHERE id = ? AND organization_id = ?")->execute([$data['id'], orgId($session)]);
            writeAudit($db, $session, 'delete', 'worker', (int)$data['id']);
            sendResponse(["message" => "Worker deleted successfully"]);

        default:
            sendResponse(["error" => "Method not allowed"], 405);
    }
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
