<?php
require_once __DIR__ . '/config.php';

function getRequestToken() {
    $keys = ['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'HTTP_X_AUTH_TOKEN'];
    foreach ($keys as $key) {
        if (empty($_SERVER[$key])) continue;
        $value = trim($_SERVER[$key]);
        if (stripos($value, 'Bearer ') === 0) {
            return trim(substr($value, 7));
        }
        return $value;
    }
    if (!empty($_COOKIE['geo_session'])) return trim($_COOKIE['geo_session']);
    if (!empty($_GET['token'])) return trim($_GET['token']);
    return null;
}

function sessionCookieOptions($expires) {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    return [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => $https
    ];
}

function createSession($db, $role, $userId, $fingerprint = null, $days = 7) {
    $raw = bin2hex(random_bytes(32));
    $hash = hash('sha256', $raw);
    $expires = date('Y-m-d H:i:s', time() + ($days * 86400));
    $stmt = $db->prepare("INSERT INTO sessions (token_hash, role, user_id, device_fingerprint, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, NOW())");
    $stmt->execute([$hash, $role, $userId, $fingerprint, $expires]);
    setcookie('geo_session', $raw, sessionCookieOptions(time() + ($days * 86400)));
    return $raw;
}

function destroySession($db, $token) {
    if ($token) {
        $stmt = $db->prepare("DELETE FROM sessions WHERE token_hash = ?");
        $stmt->execute([hash('sha256', $token)]);
    }
    setcookie('geo_session', '', sessionCookieOptions(time() - 3600));
}

function requireAuth($db, $roles = null) {
    $token = getRequestToken();
    if (!$token) {
        sendResponse(["error" => "Authentication required"], 401);
    }
    $stmt = $db->prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > NOW() LIMIT 1");
    $stmt->execute([hash('sha256', $token)]);
    $session = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$session) {
        sendResponse(["error" => "Invalid or expired session"], 401);
    }
    $allowed = $roles ? (array)$roles : null;
    if ($allowed && !in_array($session['role'], $allowed, true)) {
        sendResponse(["error" => "Forbidden"], 403);
    }
    $db->prepare("UPDATE sessions SET last_seen = NOW() WHERE id = ?")->execute([$session['id']]);
    return $session;
}

function requireWorker($db) {
    return requireAuth($db, ['worker']);
}

function normalizeAdminPrivilege($value) {
    return $value === 'super_admin' ? 'super_admin' : 'admin';
}

function publicAdminUser($admin) {
    $privilege = normalizeAdminPrivilege($admin['privilege'] ?? 'admin');
    return [
        'id' => (int)$admin['id'],
        'name' => $admin['name'],
        'email' => $admin['email'],
        'privilege' => $privilege,
        'organization_id' => !empty($admin['organization_id']) ? (int)$admin['organization_id'] : null,
        'organization_name' => $admin['organization_name'] ?? null
    ];
}

function getAdminRecord($db, $userId) {
    $sql = "SELECT a.id, a.name, a.email, a.privilege, a.is_active, a.organization_id,
            o.name AS organization_name, o.is_active AS organization_active
        FROM admins a
        LEFT JOIN organizations o ON o.id = a.organization_id
        WHERE a.id = ? AND COALESCE(a.is_active, 1) = 1 LIMIT 1";
    $stmt = $db->prepare($sql);
    $stmt->execute([$userId]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

function attachAdminContext($db, $session) {
    $admin = getAdminRecord($db, $session['user_id']);
    if (!$admin) {
        sendResponse(["error" => "Admin not found"], 401);
    }
    $session['privilege'] = normalizeAdminPrivilege($admin['privilege'] ?? 'admin');
    $session['organization_id'] = $admin['organization_id'] ? (int)$admin['organization_id'] : null;
    $session['organization_name'] = $admin['organization_name'] ?? null;
    $session['organization_active'] = isset($admin['organization_active']) ? (int)$admin['organization_active'] : null;
    $session['admin'] = $admin;
    return $session;
}

function requireAdminSession($db) {
    return attachAdminContext($db, requireAuth($db, ['admin']));
}

function requireOrgAdmin($db) {
    $session = requireAdminSession($db);
    if ($session['privilege'] === 'super_admin') {
        sendResponse(["error" => "This console is for organization admins"], 403);
    }
    if (empty($session['organization_id'])) {
        sendResponse(["error" => "This account is not linked to an organization"], 403);
    }
    if ((int)$session['organization_active'] !== 1) {
        sendResponse(["error" => "This organization is suspended. Contact Geo-Lo."], 403);
    }
    return $session;
}

function requireAdmin($db) {
    return requireOrgAdmin($db);
}

function requireSuperAdmin($db) {
    $session = requireAdminSession($db);
    if ($session['privilege'] !== 'super_admin') {
        sendResponse(["error" => "Geo-Lo owner access required"], 403);
    }
    return $session;
}

function orgId($session) {
    return (int)($session['organization_id'] ?? 0);
}

function assertOrgRow($db, $table, $id, $organizationId, $label = 'Record') {
    $stmt = $db->prepare("SELECT id FROM `$table` WHERE id = ? AND organization_id = ? LIMIT 1");
    $stmt->execute([$id, $organizationId]);
    if (!$stmt->fetch()) {
        sendResponse(["error" => "$label not found"], 404);
    }
}

function workerOrganizationId($db, $workerId) {
    $stmt = $db->prepare("SELECT organization_id FROM workers WHERE id = ? LIMIT 1");
    $stmt->execute([$workerId]);
    $id = $stmt->fetchColumn();
    return $id ? (int)$id : null;
}

function writeAudit($db, $session, $action, $entity, $entityId = null, $details = null) {
    $orgId = $session['organization_id'] ?? null;
    if (!$orgId && is_array($details) && !empty($details['organization_id'])) {
        $orgId = $details['organization_id'];
    }
    $stmt = $db->prepare("INSERT INTO audit_log (actor_role, actor_id, organization_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)");
    $stmt->execute([
        $session['role'] ?? 'system',
        $session['user_id'] ?? null,
        $orgId ?: null,
        $action,
        $entity,
        $entityId,
        $details ? json_encode($details) : null
    ]);
}

function decorateAuditRows($db, array $rows) {
    if (!$rows) return $rows;

    $adminIds = [];
    $workerIds = [];
    $orgIds = [];
    foreach ($rows as $row) {
        if (($row['actor_role'] ?? '') === 'admin' && !empty($row['actor_id'])) {
            $adminIds[(int)$row['actor_id']] = true;
        }
        if (($row['actor_role'] ?? '') === 'worker' && !empty($row['actor_id'])) {
            $workerIds[(int)$row['actor_id']] = true;
        }
        if (!empty($row['organization_id'])) {
            $orgIds[(int)$row['organization_id']] = true;
        }
    }

    $admins = [];
    if ($adminIds) {
        $ids = implode(',', array_map('intval', array_keys($adminIds)));
        $stmt = $db->query("SELECT a.id, a.name, a.privilege, a.organization_id, o.name AS organization_name
            FROM admins a LEFT JOIN organizations o ON o.id = a.organization_id
            WHERE a.id IN ($ids)");
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $admin) {
            $admins[(int)$admin['id']] = $admin;
        }
    }

    $workers = [];
    if ($workerIds) {
        $ids = implode(',', array_map('intval', array_keys($workerIds)));
        $stmt = $db->query("SELECT w.id, w.name, w.organization_id, o.name AS organization_name
            FROM workers w LEFT JOIN organizations o ON o.id = w.organization_id
            WHERE w.id IN ($ids)");
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $worker) {
            $workers[(int)$worker['id']] = $worker;
        }
    }

    $orgs = [];
    if ($orgIds) {
        $ids = implode(',', array_map('intval', array_keys($orgIds)));
        $stmt = $db->query("SELECT id, name FROM organizations WHERE id IN ($ids)");
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $org) {
            $orgs[(int)$org['id']] = $org['name'];
        }
    }

    foreach ($rows as &$row) {
        $role = $row['actor_role'] ?? 'system';
        $actorId = !empty($row['actor_id']) ? (int)$row['actor_id'] : null;
        $orgName = !empty($row['organization_id']) ? ($orgs[(int)$row['organization_id']] ?? null) : null;
        $kind = $role;
        $label = 'System';

        if ($role === 'admin' && $actorId && isset($admins[$actorId])) {
            $admin = $admins[$actorId];
            if (normalizeAdminPrivilege($admin['privilege'] ?? 'admin') === 'super_admin') {
                $kind = 'super_admin';
                $label = 'Geo-Lo owner · ' . $admin['name'];
            } else {
                $kind = 'org_admin';
                $label = 'Org admin · ' . $admin['name'];
                if (!$orgName && !empty($admin['organization_name'])) {
                    $orgName = $admin['organization_name'];
                }
            }
        } elseif ($role === 'worker' && $actorId && isset($workers[$actorId])) {
            $kind = 'worker';
            $label = 'Worker · ' . $workers[$actorId]['name'];
            if (!$orgName && !empty($workers[$actorId]['organization_name'])) {
                $orgName = $workers[$actorId]['organization_name'];
            }
        } elseif ($role === 'admin') {
            $label = 'Admin #' . ($actorId ?: '—');
        } elseif ($role === 'worker') {
            $label = 'Worker #' . ($actorId ?: '—');
        } elseif ($role !== 'system') {
            $label = $role . ($actorId ? ' #' . $actorId : '');
        }

        $row['actor_kind'] = $kind;
        $row['actor_label'] = $label;
        $row['organization_name'] = $orgName;
    }
    unset($row);

    return $rows;
}

function createAlert($db, $type, $message, $workerId = null, $attendanceId = null) {
    $stmt = $db->prepare("SELECT id FROM alerts WHERE type = ? AND worker_id <=> ? AND attendance_id <=> ? AND DATE(created_at) = CURDATE() LIMIT 1");
    $stmt->execute([$type, $workerId, $attendanceId]);
    if ($stmt->fetch()) return;
    $orgId = $workerId ? workerOrganizationId($db, $workerId) : null;
    $stmt = $db->prepare("INSERT INTO alerts (type, worker_id, attendance_id, organization_id, message) VALUES (?, ?, ?, ?, ?)");
    $stmt->execute([$type, $workerId, $attendanceId, $orgId, $message]);
}

function logPunchAttempt($db, $workerId, $action, $data, $success, $reason) {
    try {
        $stmt = $db->prepare("INSERT INTO punch_attempts (worker_id, action, latitude, longitude, accuracy_meters, success, reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
        $stmt->execute([
            $workerId,
            $action,
            $data['latitude'] ?? null,
            $data['longitude'] ?? null,
            isset($data['accuracy']) ? (int)$data['accuracy'] : null,
            $success ? 1 : 0,
            $reason
        ]);
    } catch (Exception $e) {}
}
