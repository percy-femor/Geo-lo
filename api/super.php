<?php
require_once 'config.php';
require_once 'auth_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

function slugifyOrgName($name) {
    $slug = strtolower(trim($name));
    $slug = preg_replace('/[^a-z0-9]+/', '-', $slug);
    $slug = trim($slug, '-');
    return $slug !== '' ? substr($slug, 0, 80) : 'organization';
}

function uniqueOrgSlug($db, $base, $exceptId = null) {
    $slug = $base;
    $n = 2;
    while (true) {
        $sql = "SELECT id FROM organizations WHERE slug = ?";
        $params = [$slug];
        if ($exceptId) {
            $sql .= " AND id <> ?";
            $params[] = $exceptId;
        }
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        if (!$stmt->fetch()) return $slug;
        $slug = substr($base, 0, 70) . '-' . $n;
        $n++;
    }
}

function emailTaken($db, $email, $exceptAdminId = null) {
    if (strtolower(trim($email)) === 'boss@geo-lo') {
        return 'This email is reserved for the Geo-Lo owner';
    }
    $stmt = $db->prepare("SELECT id FROM workers WHERE email = ? LIMIT 1");
    $stmt->execute([$email]);
    if ($stmt->fetch()) return 'This email belongs to a worker account';

    $sql = "SELECT id FROM admins WHERE email = ?";
    $params = [$email];
    if ($exceptAdminId) {
        $sql .= " AND id <> ?";
        $params[] = $exceptAdminId;
    }
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    if ($stmt->fetch()) return 'An admin with this email already exists';
    return null;
}

function revokeAdminSessions($db, $adminId, $keepTokenHash = null) {
    if ($keepTokenHash) {
        $stmt = $db->prepare("DELETE FROM sessions WHERE role = 'admin' AND user_id = ? AND token_hash <> ?");
        $stmt->execute([$adminId, $keepTokenHash]);
        return;
    }
    $stmt = $db->prepare("DELETE FROM sessions WHERE role = 'admin' AND user_id = ?");
    $stmt->execute([$adminId]);
}

function seedOrgShift($db, $orgId) {
    $stmt = $db->prepare("INSERT INTO shifts (name, start_time, end_time, work_days, late_grace_minutes, overtime_after_minutes, break_minutes, organization_id)
        VALUES ('Standard day', '08:00:00', '17:00:00', '1,2,3,4,5', 10, 0, 60, ?)");
    $stmt->execute([$orgId]);
}

function createOrgAdminAccount($db, $session, $orgId, $name, $email, $password) {
    $taken = emailTaken($db, $email);
    if ($taken) sendResponse(["error" => $taken], 409);
    if (strlen($password) < 8) sendResponse(["error" => "Password must be at least 8 characters"], 400);
    $stmt = $db->prepare("INSERT INTO admins (name, email, password_hash, privilege, organization_id, is_active) VALUES (?, ?, ?, 'admin', ?, 1)");
    $stmt->execute([$name, $email, password_hash($password, PASSWORD_DEFAULT), $orgId]);
    $id = (int)$db->lastInsertId();
    writeAudit($db, $session, 'create', 'admin', $id, ['email' => $email, 'organization_id' => $orgId]);
    return $id;
}

try {
    $session = requireSuperAdmin($db);

    if ($method === 'GET') {
        $type = $_GET['type'] ?? 'overview';

        if ($type === 'overview') {
            $orgs = (int)$db->query("SELECT COUNT(*) FROM organizations")->fetchColumn();
            $orgsActive = (int)$db->query("SELECT COUNT(*) FROM organizations WHERE COALESCE(is_active, 1) = 1")->fetchColumn();
            $orgAdmins = (int)$db->query("SELECT COUNT(*) FROM admins WHERE privilege <> 'super_admin' AND COALESCE(is_active, 1) = 1")->fetchColumn();
            $workersActive = (int)$db->query("SELECT COUNT(*) FROM workers WHERE COALESCE(is_active, 1) = 1")->fetchColumn();
            $sessions = (int)$db->query("SELECT COUNT(*) FROM sessions WHERE expires_at > NOW()")->fetchColumn();
            $onSite = (int)$db->query("SELECT COUNT(*) FROM attendance WHERE check_out IS NULL")->fetchColumn();
            $failedToday = tableExists($db, 'punch_attempts')
                ? (int)$db->query("SELECT COUNT(*) FROM punch_attempts WHERE success = 0 AND DATE(created_at) = CURDATE()")->fetchColumn()
                : 0;

            $recentOrgs = $db->query("SELECT id, name, is_active, created_at FROM organizations ORDER BY created_at DESC LIMIT 8")->fetchAll(PDO::FETCH_ASSOC);
            $recentAudit = decorateAuditRows($db, $db->query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 8")->fetchAll(PDO::FETCH_ASSOC));

            sendResponse([
                'counts' => [
                    'organizations' => $orgs,
                    'organizations_active' => $orgsActive,
                    'org_admins' => $orgAdmins,
                    'workers_active' => $workersActive,
                    'sessions_active' => $sessions,
                    'on_site' => $onSite,
                    'failed_punches_today' => $failedToday
                ],
                'recent_organizations' => $recentOrgs,
                'recent_audit' => $recentAudit,
                'you' => ['id' => (int)$session['user_id'], 'privilege' => 'super_admin']
            ]);
        }

        if ($type === 'organizations') {
            $stmt = $db->query("SELECT o.*,
                (SELECT COUNT(*) FROM admins a WHERE a.organization_id = o.id AND COALESCE(a.is_active,1)=1) AS admin_count,
                (SELECT COUNT(*) FROM workers w WHERE w.organization_id = o.id AND COALESCE(w.is_active,1)=1) AS worker_count,
                (SELECT COUNT(*) FROM locations l WHERE l.organization_id = o.id) AS location_count
                FROM organizations o ORDER BY o.name");
            sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
        }

        if ($type === 'admins') {
            $orgFilter = isset($_GET['organization_id']) ? (int)$_GET['organization_id'] : 0;
            $sql = "SELECT a.id, a.name, a.email, a.privilege, a.is_active, a.created_at, a.organization_id, o.name AS organization_name,
                (SELECT MAX(s.last_seen) FROM sessions s WHERE s.role = 'admin' AND s.user_id = a.id) AS last_seen
                FROM admins a LEFT JOIN organizations o ON o.id = a.organization_id
                WHERE a.privilege <> 'super_admin'";
            $params = [];
            if ($orgFilter) {
                $sql .= " AND a.organization_id = ?";
                $params[] = $orgFilter;
            }
            $sql .= " ORDER BY o.name, a.name";
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
        }

        if ($type === 'sessions') {
            $stmt = $db->query("SELECT s.id, s.role, s.user_id, s.device_fingerprint, s.expires_at, s.last_seen, s.created_at,
                CASE WHEN s.role = 'admin' THEN ad.name WHEN s.role = 'worker' THEN w.name ELSE NULL END AS user_name,
                CASE WHEN s.role = 'admin' THEN ad.email WHEN s.role = 'worker' THEN w.email ELSE NULL END AS user_email,
                CASE WHEN s.role = 'admin' THEN ad.privilege ELSE NULL END AS privilege,
                CASE WHEN s.role = 'admin' THEN o.name WHEN s.role = 'worker' THEN wo.name ELSE NULL END AS organization_name
                FROM sessions s
                LEFT JOIN admins ad ON s.role = 'admin' AND ad.id = s.user_id
                LEFT JOIN organizations o ON s.role = 'admin' AND o.id = ad.organization_id
                LEFT JOIN workers w ON s.role = 'worker' AND w.id = s.user_id
                LEFT JOIN organizations wo ON s.role = 'worker' AND wo.id = w.organization_id
                WHERE s.expires_at > NOW()
                ORDER BY s.last_seen DESC, s.created_at DESC");
            sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
        }

        if ($type === 'workers') {
            $stmt = $db->query("SELECT w.id, w.employee_id, w.name, w.email, w.phone, w.is_active, w.created_at,
                w.device_bound, w.require_face, s.name AS shift_name, o.name AS organization_name, o.id AS organization_id,
                (SELECT COUNT(*) FROM attendance a WHERE a.worker_id = w.id) AS punch_count
                FROM workers w
                LEFT JOIN shifts s ON s.id = w.shift_id
                LEFT JOIN organizations o ON o.id = w.organization_id
                ORDER BY o.name, w.name");
            sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
        }

        if ($type === 'audit') {
            $limit = min(500, max(20, (int)($_GET['limit'] ?? 200)));
            $action = trim($_GET['action'] ?? '');
            $entity = trim($_GET['entity'] ?? '');
            $sql = "SELECT * FROM audit_log WHERE 1=1";
            $params = [];
            if ($action !== '') {
                $sql .= " AND action LIKE ?";
                $params[] = '%' . $action . '%';
            }
            if ($entity !== '') {
                $sql .= " AND entity = ?";
                $params[] = $entity;
            }
            $sql .= " ORDER BY created_at DESC LIMIT " . $limit;
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            sendResponse(decorateAuditRows($db, $stmt->fetchAll(PDO::FETCH_ASSOC)));
        }

        if ($type === 'security') {
            $failedToday = 0;
            $failedWeek = 0;
            $attempts = [];
            if (tableExists($db, 'punch_attempts')) {
                $failedToday = (int)$db->query("SELECT COUNT(*) FROM punch_attempts WHERE success = 0 AND DATE(created_at) = CURDATE()")->fetchColumn();
                $failedWeek = (int)$db->query("SELECT COUNT(*) FROM punch_attempts WHERE success = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)")->fetchColumn();
                $attempts = $db->query("SELECT p.*, w.name AS worker_name, w.employee_id, o.name AS organization_name
                    FROM punch_attempts p
                    LEFT JOIN workers w ON w.id = p.worker_id
                    LEFT JOIN organizations o ON o.id = w.organization_id
                    ORDER BY p.created_at DESC LIMIT 150")->fetchAll(PDO::FETCH_ASSOC);
            }
            $bound = (int)$db->query("SELECT COUNT(*) FROM workers WHERE COALESCE(device_bound, 0) = 1 AND COALESCE(is_active, 1) = 1")->fetchColumn();
            $faceRequired = columnExists($db, 'workers', 'require_face')
                ? (int)$db->query("SELECT COUNT(*) FROM workers WHERE COALESCE(require_face, 0) = 1 AND COALESCE(is_active, 1) = 1")->fetchColumn()
                : 0;
            sendResponse([
                'failed_today' => $failedToday,
                'failed_week' => $failedWeek,
                'device_bound_workers' => $bound,
                'face_required_workers' => $faceRequired,
                'attempts' => $attempts
            ]);
        }

        sendResponse(["error" => "Unknown resource"], 400);
    }

    $data = getJsonInput() ?: [];
    $action = $data['action'] ?? '';

    if ($method === 'POST') {
        if ($action === 'create_organization') {
            $name = trim($data['name'] ?? '');
            if ($name === '') sendResponse(["error" => "Organization name is required"], 400);
            $slug = uniqueOrgSlug($db, slugifyOrgName($name));
            $stmt = $db->prepare("INSERT INTO organizations (name, slug, contact_email, phone, notes, is_active) VALUES (?, ?, ?, ?, ?, 1)");
            $stmt->execute([
                $name,
                $slug,
                trim($data['contact_email'] ?? '') ?: null,
                trim($data['phone'] ?? '') ?: null,
                trim($data['notes'] ?? '') ?: null
            ]);
            $orgId = (int)$db->lastInsertId();
            seedOrgShift($db, $orgId);
            $adminId = null;
            $adminName = trim($data['admin_name'] ?? '');
            $adminEmail = trim($data['admin_email'] ?? '');
            $adminPassword = $data['admin_password'] ?? '';
            if ($adminName && $adminEmail && $adminPassword) {
                if (!filter_var($adminEmail, FILTER_VALIDATE_EMAIL)) {
                    sendResponse(["error" => "Enter a valid admin email"], 400);
                }
                $adminId = createOrgAdminAccount($db, $session, $orgId, $adminName, $adminEmail, $adminPassword);
            }
            writeAudit($db, $session, 'create', 'organization', $orgId, ['name' => $name, 'organization_id' => $orgId]);
            sendResponse(["message" => "Organization hooked onto Geo-Lo", "id" => $orgId, "admin_id" => $adminId], 201);
        }

        if ($action === 'create_admin') {
            $orgId = (int)($data['organization_id'] ?? 0);
            $name = trim($data['name'] ?? '');
            $email = trim($data['email'] ?? '');
            $password = $data['password'] ?? '';
            if (!$orgId || $name === '' || $email === '' || $password === '') {
                sendResponse(["error" => "Organization, name, email, and password are required"], 400);
            }
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                sendResponse(["error" => "Enter a valid email address"], 400);
            }
            $org = $db->prepare("SELECT id FROM organizations WHERE id = ?");
            $org->execute([$orgId]);
            if (!$org->fetch()) sendResponse(["error" => "Organization not found"], 404);
            $id = createOrgAdminAccount($db, $session, $orgId, $name, $email, $password);
            sendResponse(["message" => "Organization admin created", "id" => $id], 201);
        }

        sendResponse(["error" => "Unsupported action"], 400);
    }

    if ($method === 'PUT') {
        if ($action === 'update_organization') {
            $id = (int)($data['id'] ?? 0);
            if (!$id) sendResponse(["error" => "Organization ID required"], 400);
            $fields = [];
            $values = [];
            $details = [];
            if (isset($data['name'])) {
                $name = trim($data['name']);
                if ($name === '') sendResponse(["error" => "Name cannot be empty"], 400);
                $fields[] = "name = ?";
                $values[] = $name;
                $details['name'] = $name;
            }
            foreach (['contact_email', 'phone', 'notes'] as $field) {
                if (isset($data[$field])) {
                    $fields[] = "$field = ?";
                    $values[] = trim((string)$data[$field]) ?: null;
                    $details[$field] = $data[$field];
                }
            }
            if (isset($data['is_active'])) {
                $active = !empty($data['is_active']) ? 1 : 0;
                $fields[] = "is_active = ?";
                $values[] = $active;
                $details['is_active'] = $active;
                if ($active === 0) {
                    $admins = $db->prepare("SELECT id FROM admins WHERE organization_id = ?");
                    $admins->execute([$id]);
                    foreach ($admins as $row) {
                        revokeAdminSessions($db, $row['id']);
                    }
                    $workers = $db->prepare("SELECT id FROM workers WHERE organization_id = ?");
                    $workers->execute([$id]);
                    $workerIds = $workers->fetchAll(PDO::FETCH_COLUMN);
                    if ($workerIds) {
                        $in = implode(',', array_map('intval', $workerIds));
                        $db->exec("DELETE FROM sessions WHERE role = 'worker' AND user_id IN ($in)");
                    }
                }
            }
            if (!$fields) sendResponse(["message" => "No fields to update"]);
            $values[] = $id;
            $db->prepare("UPDATE organizations SET " . implode(', ', $fields) . " WHERE id = ?")->execute($values);
            $details['organization_id'] = $id;
            writeAudit($db, $session, 'update', 'organization', $id, $details);
            sendResponse(["message" => "Organization updated"]);
        }

        if ($action === 'update_admin') {
            $id = (int)($data['id'] ?? 0);
            if (!$id) sendResponse(["error" => "Admin ID required"], 400);
            $stmt = $db->prepare("SELECT * FROM admins WHERE id = ?");
            $stmt->execute([$id]);
            $target = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$target) sendResponse(["error" => "Admin not found"], 404);
            if (normalizeAdminPrivilege($target['privilege'] ?? 'admin') === 'super_admin') {
                sendResponse(["error" => "Geo-Lo owner accounts are not managed here"], 400);
            }

            $fields = [];
            $values = [];
            $details = [];
            if (isset($data['name'])) {
                $name = trim($data['name']);
                if ($name === '') sendResponse(["error" => "Name cannot be empty"], 400);
                $fields[] = "name = ?";
                $values[] = $name;
                $details['name'] = $name;
            }
            if (isset($data['email'])) {
                $email = trim($data['email']);
                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                    sendResponse(["error" => "Enter a valid email address"], 400);
                }
                $taken = emailTaken($db, $email, $id);
                if ($taken) sendResponse(["error" => $taken], 409);
                $fields[] = "email = ?";
                $values[] = $email;
                $details['email'] = $email;
            }
            if (!empty($data['password'])) {
                if (strlen($data['password']) < 8) {
                    sendResponse(["error" => "Password must be at least 8 characters"], 400);
                }
                $fields[] = "password_hash = ?";
                $values[] = password_hash($data['password'], PASSWORD_DEFAULT);
                $details['password'] = 'reset';
            }
            if (isset($data['organization_id'])) {
                $orgId = (int)$data['organization_id'];
                $org = $db->prepare("SELECT id FROM organizations WHERE id = ?");
                $org->execute([$orgId]);
                if (!$org->fetch()) sendResponse(["error" => "Organization not found"], 404);
                $fields[] = "organization_id = ?";
                $values[] = $orgId;
                $details['organization_id'] = $orgId;
            }
            if (isset($data['is_active'])) {
                $active = !empty($data['is_active']) ? 1 : 0;
                $fields[] = "is_active = ?";
                $values[] = $active;
                $details['is_active'] = $active;
                if ($active === 0) revokeAdminSessions($db, $id);
            }
            if (!$fields) sendResponse(["message" => "No fields to update"]);
            $values[] = $id;
            $db->prepare("UPDATE admins SET " . implode(', ', $fields) . " WHERE id = ?")->execute($values);
            if (!empty($data['password'])) {
                revokeAdminSessions($db, $id);
            }
            if (empty($details['organization_id']) && !empty($target['organization_id'])) {
                $details['organization_id'] = (int)$target['organization_id'];
            }
            writeAudit($db, $session, 'update', 'admin', $id, $details);
            sendResponse(["message" => "Organization admin updated"]);
        }

        if ($action === 'restore_worker') {
            $id = (int)($data['id'] ?? 0);
            if (!$id) sendResponse(["error" => "Worker ID required"], 400);
            $db->prepare("UPDATE workers SET is_active = 1 WHERE id = ?")->execute([$id]);
            writeAudit($db, $session, 'restore', 'worker', $id, ['organization_id' => workerOrganizationId($db, $id)]);
            sendResponse(["message" => "Worker restored"]);
        }

        if ($action === 'deactivate_worker') {
            $id = (int)($data['id'] ?? 0);
            if (!$id) sendResponse(["error" => "Worker ID required"], 400);
            $db->prepare("UPDATE workers SET is_active = 0 WHERE id = ?")->execute([$id]);
            $db->prepare("DELETE FROM sessions WHERE role = 'worker' AND user_id = ?")->execute([$id]);
            writeAudit($db, $session, 'delete', 'worker', $id, ['organization_id' => workerOrganizationId($db, $id)]);
            sendResponse(["message" => "Worker deactivated"]);
        }

        sendResponse(["error" => "Unsupported action"], 400);
    }

    if ($method === 'DELETE') {
        if ($action === 'revoke_session') {
            $id = (int)($data['id'] ?? 0);
            if (!$id) sendResponse(["error" => "Session ID required"], 400);
            $stmt = $db->prepare("SELECT id, role, user_id FROM sessions WHERE id = ?");
            $stmt->execute([$id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) sendResponse(["error" => "Session not found"], 404);
            $db->prepare("DELETE FROM sessions WHERE id = ?")->execute([$id]);
            writeAudit($db, $session, 'revoke_session', $row['role'], (int)$row['user_id'], ['session_id' => $id]);
            sendResponse(["message" => "Session revoked"]);
        }

        sendResponse(["error" => "Unsupported action"], 400);
    }

    sendResponse(["error" => "Method not allowed"], 405);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
