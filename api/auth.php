<?php
require_once 'config.php';
require_once 'auth_lib.php';
require_once 'face_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method === 'GET') {
        $session = requireAuth($db);
        if ($session['role'] === 'admin') {
            $session = attachAdminContext($db, $session);
            $admin = $session['admin'];
            if ($session['privilege'] !== 'super_admin') {
                if (empty($session['organization_id'])) {
                    sendResponse(["error" => "This account is not linked to an organization"], 403);
                }
                if ((int)$session['organization_active'] !== 1) {
                    sendResponse(["error" => "This organization is suspended. Contact Geo-Lo."], 403);
                }
            }
            $user = publicAdminUser($admin);
            sendResponse(["role" => "admin", "privilege" => $user['privilege'], "user" => $user]);
        }
        $stmt = $db->prepare("SELECT w.id, w.employee_id, w.name, w.email, w.phone, w.shift_id, w.require_face, w.device_bound, s.name AS shift_name, s.start_time, s.end_time
            FROM workers w LEFT JOIN shifts s ON s.id = w.shift_id
            WHERE w.id = ? AND COALESCE(w.is_active, 1) = 1");
        $stmt->execute([$session['user_id']]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) sendResponse(["error" => "Worker not found"], 401);
        $user['has_face'] = getEnrolledFaceHash($db, $user['id']) ? true : false;
        sendResponse(["role" => "worker", "user" => $user]);
    }

    if ($method === 'POST') {
        $data = getJsonInput() ?: [];
        if (($data['action'] ?? '') === 'logout') {
            destroySession($db, getRequestToken());
            sendResponse(["message" => "Logged out"]);
        }

        $role = $data['role'] ?? 'worker';
        $fingerprint = $data['device_fingerprint'] ?? null;

        if ($role === 'admin') {
            if (empty($data['email']) || empty($data['password'])) {
                sendResponse(["error" => "Email and password required"], 400);
            }
            $stmt = $db->prepare("SELECT id FROM workers WHERE email = ? AND COALESCE(is_active, 1) = 1 LIMIT 1");
            $stmt->execute([$data['email']]);
            if ($stmt->fetch()) {
                sendResponse(["error" => "This is a worker account. Use the worker login."], 403);
            }
            $stmt = $db->prepare("SELECT a.id, a.name, a.email, a.password_hash, a.privilege, a.organization_id, o.name AS organization_name, o.is_active AS organization_active
                FROM admins a LEFT JOIN organizations o ON o.id = a.organization_id
                WHERE LOWER(a.email) = LOWER(?) AND COALESCE(a.is_active, 1) = 1");
            $stmt->execute([$data['email']]);
            $admin = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$admin || !password_verify($data['password'], $admin['password_hash'])) {
                sendResponse(["error" => "Invalid admin credentials"], 401);
            }
            $privilege = normalizeAdminPrivilege($admin['privilege'] ?? 'admin');
            $console = $data['console'] ?? '';
            if ($console === 'super' && $privilege !== 'super_admin') {
                sendResponse(["error" => "This is an organization admin account. Use the organization login."], 403);
            }
            if ($console === 'org' && $privilege === 'super_admin') {
                sendResponse(["error" => "Geo-Lo owner accounts sign in on the owner login page."], 403);
            }
            if ($privilege !== 'super_admin') {
                if (empty($admin['organization_id'])) {
                    sendResponse(["error" => "This account is not linked to an organization"], 403);
                }
                if ((int)$admin['organization_active'] !== 1) {
                    sendResponse(["error" => "This organization is suspended. Contact Geo-Lo."], 403);
                }
            }
            $user = publicAdminUser($admin);
            $token = createSession($db, 'admin', $admin['id'], $fingerprint);
            writeAudit($db, ['role' => 'admin', 'user_id' => $admin['id'], 'organization_id' => $user['organization_id']], 'login', 'admin', $admin['id'], ['privilege' => $privilege]);
            sendResponse([
                "token" => $token,
                "role" => "admin",
                "privilege" => $privilege,
                "user" => $user
            ]);
        }

        if (empty($data['email']) || empty($data['pin'])) {
            sendResponse(["error" => "Email and PIN required"], 400);
        }
        $stmt = $db->prepare("SELECT id, employee_id, name, email, pin_hash, device_fingerprint, device_bound, organization_id FROM workers WHERE email = ? AND COALESCE(is_active, 1) = 1");
        $stmt->execute([$data['email']]);
        $worker = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$worker || empty($worker['pin_hash']) || !password_verify($data['pin'], $worker['pin_hash'])) {
            sendResponse(["error" => "Invalid credentials"], 401);
        }
        if (!empty($worker['organization_id'])) {
            $orgActive = $db->prepare("SELECT is_active FROM organizations WHERE id = ?");
            $orgActive->execute([$worker['organization_id']]);
            if ((int)$orgActive->fetchColumn() !== 1) {
                sendResponse(["error" => "This organization is suspended. Contact your admin."], 403);
            }
        }
        if ((int)$worker['device_bound'] === 1 && !empty($worker['device_fingerprint']) && $fingerprint && $worker['device_fingerprint'] !== $fingerprint) {
            sendResponse(["error" => "This account is bound to another device. Ask an admin to reset it."], 403);
        }
        if ((int)$worker['device_bound'] !== 1 && $fingerprint) {
            $db->prepare("UPDATE workers SET device_fingerprint = ?, device_bound = 1 WHERE id = ?")->execute([$fingerprint, $worker['id']]);
        }
        $token = createSession($db, 'worker', $worker['id'], $fingerprint);
        require_once 'face_lib.php';
        $hasFace = getEnrolledFaceHash($db, $worker['id']) ? true : false;
        sendResponse([
            "token" => $token,
            "role" => "worker",
            "id" => $worker['id'],
            "employee_id" => $worker['employee_id'],
            "name" => $worker['name'],
            "email" => $worker['email'],
            "has_face" => $hasFace,
            "user" => [
                "id" => $worker['id'],
                "employee_id" => $worker['employee_id'],
                "name" => $worker['name'],
                "email" => $worker['email'],
                "has_face" => $hasFace
            ]
        ]);
    }

    if ($method === 'PUT') {
        $session = requireAuth($db);
        $data = getJsonInput() ?: [];
        if (($data['action'] ?? '') !== 'password') {
            sendResponse(["error" => "Unsupported action"], 400);
        }
        $current = $data['current_password'] ?? '';
        $next = $data['new_password'] ?? '';
        if (!$current || !$next || strlen($next) < 6) {
            sendResponse(["error" => "Current password and a new password (6+ characters) are required"], 400);
        }
        if ($session['role'] === 'admin') {
            $stmt = $db->prepare("SELECT password_hash FROM admins WHERE id = ?");
            $stmt->execute([$session['user_id']]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row || !password_verify($current, $row['password_hash'])) {
                sendResponse(["error" => "Current password is incorrect"], 401);
            }
            $db->prepare("UPDATE admins SET password_hash = ? WHERE id = ?")->execute([password_hash($next, PASSWORD_DEFAULT), $session['user_id']]);
            sendResponse(["message" => "Password updated"]);
        }
        sendResponse(["error" => "Workers should use PIN reset"], 400);
    }

    sendResponse(["error" => "Method not allowed"], 405);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
