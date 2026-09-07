<?php
require_once 'config.php';
require_once 'auth_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

try {
    switch ($method) {
        case 'GET':
            $session = requireAuth($db, ['admin', 'worker']);
            if ($session['role'] === 'worker') {
                $oid = workerOrganizationId($db, $session['user_id']);
                $stmt = $db->prepare("SELECT * FROM locations WHERE organization_id <=> ? ORDER BY is_default DESC, name ASC");
                $stmt->execute([$oid]);
                sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
            }
            $session = requireOrgAdmin($db);
            $stmt = $db->prepare("SELECT * FROM locations WHERE organization_id = ? ORDER BY is_default DESC, name ASC");
            $stmt->execute([orgId($session)]);
            sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));

        case 'POST':
            $session = requireOrgAdmin($db);
            $oid = orgId($session);
            $data = getJsonInput();
            foreach (['name', 'latitude', 'longitude'] as $field) {
                if (!isset($data[$field])) sendResponse(["error" => "Missing required field: $field"], 400);
            }
            if (!empty($data['is_default'])) {
                $db->prepare("UPDATE locations SET is_default = 0 WHERE organization_id = ?")->execute([$oid]);
            }
            $stmt = $db->prepare("INSERT INTO locations (name, latitude, longitude, radius_meters, is_default, organization_id) VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $data['name'],
                $data['latitude'],
                $data['longitude'],
                $data['radius_meters'] ?? 100,
                $data['is_default'] ?? false,
                $oid
            ]);
            writeAudit($db, $session, 'create', 'location', (int)$db->lastInsertId(), $data);
            sendResponse(["message" => "Location added successfully"], 201);

        case 'PUT':
            $session = requireOrgAdmin($db);
            $oid = orgId($session);
            $data = getJsonInput();
            if (!isset($data['id'])) sendResponse(["error" => "Location ID required"], 400);
            assertOrgRow($db, 'locations', $data['id'], $oid, 'Location');
            if (!empty($data['is_default'])) {
                $db->prepare("UPDATE locations SET is_default = 0 WHERE organization_id = ?")->execute([$oid]);
            }
            $fields = [];
            $values = [];
            foreach (['name', 'latitude', 'longitude', 'radius_meters', 'is_default'] as $field) {
                if (isset($data[$field])) { $fields[] = "$field = ?"; $values[] = $data[$field]; }
            }
            if (empty($fields)) sendResponse(["message" => "No fields to update"]);
            $values[] = $data['id'];
            $values[] = $oid;
            $db->prepare("UPDATE locations SET " . implode(', ', $fields) . " WHERE id = ? AND organization_id = ?")->execute($values);
            writeAudit($db, $session, 'update', 'location', (int)$data['id']);
            sendResponse(["message" => "Location updated successfully"]);

        case 'DELETE':
            $session = requireOrgAdmin($db);
            $oid = orgId($session);
            $data = getJsonInput();
            if (!isset($data['id'])) sendResponse(["error" => "Location ID required"], 400);
            assertOrgRow($db, 'locations', $data['id'], $oid, 'Location');
            $stmt = $db->prepare("SELECT is_default FROM locations WHERE id = ? AND organization_id = ?");
            $stmt->execute([$data['id'], $oid]);
            $location = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($location && $location['is_default']) {
                sendResponse(["error" => "Cannot delete the default location"], 400);
            }
            $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM attendance WHERE location_id = ?");
            $stmt->execute([$data['id']]);
            $ref = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($ref && intval($ref['cnt']) > 0) {
                sendResponse(["error" => "Cannot delete location with existing attendance records"], 400);
            }
            $db->prepare("DELETE FROM locations WHERE id = ? AND organization_id = ?")->execute([$data['id'], $oid]);
            writeAudit($db, $session, 'delete', 'location', (int)$data['id']);
            sendResponse(["message" => "Location deleted successfully"]);

        default:
            sendResponse(["error" => "Method not allowed"], 405);
    }
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
