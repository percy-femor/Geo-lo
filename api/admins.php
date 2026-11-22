<?php
require_once 'config.php';
require_once 'auth_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

/**
 * Portal users of the signed-in organization admin: the extra admins they add
 * for their own console. Workers are managed on the Workers tab instead.
 */
function assertTeamEmailFree($db, $email, $exceptId = null) {
    if (strtolower(trim($email)) === 'boss@geo-lo') {
        sendResponse(["error" => "This email is reserved for the Geo-Lo owner"], 409);
    }
    $stmt = $db->prepare("SELECT id FROM workers WHERE email = ? LIMIT 1");
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        sendResponse(["error" => "This email belongs to a worker account"], 409);
    }
    $sql = "SELECT id FROM admins WHERE email = ?";
    $params = [$email];
    if ($exceptId) {
        $sql .= " AND id <> ?";
        $params[] = $exceptId;
    }
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    if ($stmt->fetch()) {
        sendResponse(["error" => "An admin with this email already exists"], 409);
    }
}

try {
    $session = requireOrgAdmin($db);
    $orgId = orgId($session);

    if ($method === 'GET') {
        $stmt = $db->prepare("SELECT id, name, email, privilege, is_active, must_change_password, created_at, password_changed_at
            FROM admins
            WHERE organization_id = ? AND privilege <> 'super_admin'
            ORDER BY created_at ASC");
        $stmt->execute([$orgId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            $row['id'] = (int)$row['id'];
            $row['is_active'] = (int)($row['is_active'] ?? 1);
            $row['must_change_password'] = (int)($row['must_change_password'] ?? 0);
            $row['is_self'] = ((int)$row['id'] === (int)$session['user_id']);
        }
        unset($row);
        sendResponse($rows);
    }

    if ($method === 'POST') {
        $data = getJsonInput() ?: [];
        $name = trim((string)($data['name'] ?? ''));
        $email = trim((string)($data['email'] ?? ''));
        $password = (string)($data['password'] ?? '');

        if ($name === '' || $email === '' || $password === '') {
            sendResponse(["error" => "Name, email and a starting password are required"], 400);
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            sendResponse(["error" => "Enter a valid email address"], 400);
        }
        if (strlen($password) < 8) {
            sendResponse(["error" => "The starting password must be at least 8 characters"], 400);
        }
        assertTeamEmailFree($db, $email);

        // The starting password is chosen by whoever adds the user, so flag the
        // account to pick its own on first sign-in.
        $stmt = $db->prepare("INSERT INTO admins (name, email, password_hash, privilege, organization_id, must_change_password, is_active) VALUES (?, ?, ?, 'admin', ?, 1, 1)");
        $stmt->execute([$name, $email, password_hash($password, PASSWORD_DEFAULT), $orgId]);
        $id = (int)$db->lastInsertId();
        writeAudit($db, $session, 'create', 'admin', $id, ['email' => $email, 'organization_id' => $orgId]);

        sendResponse([
            "message" => "User added. They will set their own password on first sign-in.",
            "id" => $id,
            "name" => $name,
            "email" => $email
        ], 201);
    }

    if ($method === 'DELETE') {
        $data = getJsonInput() ?: [];
        $id = (int)($data['id'] ?? 0);
        if (!$id) {
            sendResponse(["error" => "User ID required"], 400);
        }
        if ($id === (int)$session['user_id']) {
            sendResponse(["error" => "You cannot remove your own account"], 400);
        }
        $stmt = $db->prepare("SELECT id, name, email FROM admins WHERE id = ? AND organization_id = ? AND privilege <> 'super_admin' LIMIT 1");
        $stmt->execute([$id, $orgId]);
        $target = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$target) {
            sendResponse(["error" => "User not found"], 404);
        }
        $db->prepare("DELETE FROM sessions WHERE role = 'admin' AND user_id = ?")->execute([$id]);
        $db->prepare("DELETE FROM admins WHERE id = ?")->execute([$id]);
        writeAudit($db, $session, 'delete', 'admin', $id, ['email' => $target['email'], 'organization_id' => $orgId]);

        sendResponse(["message" => "User removed"]);
    }

    sendResponse(["error" => "Method not allowed"], 405);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
