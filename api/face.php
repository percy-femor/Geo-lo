<?php
require_once 'config.php';
require_once 'auth_lib.php';
require_once 'face_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method !== 'POST') {
        sendResponse(["error" => "method not allowed"], 405);
    }
    $data = getJsonInput() ?: [];
    $action = $data['action'] ?? '';

    // --- The face step of a worker sign-in (no session yet) ---------------------
    // auth.php accepted the worker's credentials and returned a challenge token in
    // place of a session. Here that challenge is exchanged for the real session once
    // the face is enrolled (the worker's first login) or matched (every login after).
    if ($action === 'login_enroll' || $action === 'login_verify') {
        $challenge = findLoginChallenge($db, $data['challenge'] ?? '', 'worker');
        if (!$challenge) {
            sendResponse(["error" => faceFailureMessage('challenge_expired'), "challenge_expired" => true], 401);
        }
        $workerId = (int)$challenge['user_id'];
        $stmt = $db->prepare("SELECT id, employee_id, name, email, organization_id FROM workers WHERE id = ? AND COALESCE(is_active, 1) = 1 LIMIT 1");
        $stmt->execute([$workerId]);
        $worker = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$worker) {
            consumeLoginChallenge($db, $challenge['id']);
            sendResponse(["error" => "Worker not found"], 401);
        }
        $descriptor = $data['descriptor'] ?? null;
        $auditSession = ['role' => 'worker', 'user_id' => $workerId, 'organization_id' => $worker['organization_id'] ?: null];

        if ($action === 'login_enroll') {
            $enrolled = enrollFaceDescriptor($db, $workerId, $descriptor);
            if ($enrolled !== true) {
                sendResponse(["error" => faceFailureMessage(is_string($enrolled) ? $enrolled : 'invalid_face')], 400);
            }
            writeAudit($db, $auditSession, 'enroll_face', 'worker', $workerId, ['context' => 'login']);
        } else {
            if (!workerHasFace($db, $workerId)) {
                // The face was reset between the two steps; make the client enroll again.
                sendResponse(["error" => "No face on file", "mode" => "enroll"], 409);
            }
            $result = verifyFaceDescriptor($db, $workerId, $descriptor);
            if (!$result['ok']) {
                $burned = failLoginChallenge($db, $challenge);
                writeAudit($db, $auditSession, 'login_face_fail', 'worker', $workerId, []);
                sendResponse([
                    "error" => faceFailureMessage($result['reason'] ?? ''),
                    "attempts_left" => max(0, LOGIN_CHALLENGE_MAX_ATTEMPTS - ((int)$challenge['attempts'] + 1)),
                    "challenge_expired" => $burned
                ], 401);
            }
        }

        // The face passed — only now does the login become a session.
        consumeLoginChallenge($db, $challenge['id']);
        $fingerprint = $challenge['device_fingerprint'] ?: null;
        if ($fingerprint) {
            $db->prepare("UPDATE workers SET device_fingerprint = ?, device_bound = 1 WHERE id = ? AND COALESCE(device_bound, 0) = 0")
                ->execute([$fingerprint, $workerId]);
        }
        $token = createSession($db, 'worker', $workerId, $fingerprint);
        writeAudit($db, $auditSession, 'login', 'worker', $workerId, ['face' => $action === 'login_enroll' ? 'enrolled' : 'verified']);
        sendResponse([
            "token" => $token,
            "role" => "worker",
            "id" => $worker['id'],
            "employee_id" => $worker['employee_id'],
            "name" => $worker['name'],
            "email" => $worker['email'],
            "has_face" => true,
            "user" => [
                "id" => $worker['id'],
                "employee_id" => $worker['employee_id'],
                "name" => $worker['name'],
                "email" => $worker['email'],
                "has_face" => true
            ]
        ]);
    }

    // --- Everything below is a signed-in caller ---------------------------------
    $session = requireAuth($db, ['admin', 'worker']);
    $workerId = $data['worker_id'] ?? null;
    if ($session['role'] === 'worker') {
        $workerId = $session['user_id'];
    }
    if ($session['role'] === 'admin') {
        $session = attachAdminContext($db, $session);
        if ($session['privilege'] === 'super_admin') {
            sendResponse(["error" => "Organization admins manage worker faces from their console"], 403);
        }
        if (empty($session['organization_id']) || (int)$session['organization_active'] !== 1) {
            sendResponse(["error" => "This console is for organization admins"], 403);
        }
        if (!$workerId) sendResponse(["error" => "worker_id required"], 400);
        if ((int)workerOrganizationId($db, $workerId) !== orgId($session)) {
            sendResponse(["error" => "Worker not found"], 404);
        }
    }
    if (!$workerId) sendResponse(["error" => "worker_id required"], 400);

    if ($action === 'enroll') {
        $descriptor = $data['descriptor'] ?? null;
        if (!$descriptor) sendResponse(["error" => "worker_id and descriptor required"], 400);
        $enrolled = enrollFaceDescriptor($db, $workerId, $descriptor);
        if ($enrolled !== true) {
            sendResponse(["error" => faceFailureMessage(is_string($enrolled) ? $enrolled : 'invalid_face')], 400);
        }
        writeAudit($db, $session, 'enroll_face', 'worker', (int)$workerId, ['organization_id' => workerOrganizationId($db, $workerId)]);
        sendResponse(["message" => "Face enrolled", "has_face" => true]);
    }

    if ($action === 'verify') {
        $descriptor = $data['descriptor'] ?? null;
        if (!$descriptor) sendResponse(["error" => "worker_id and descriptor required"], 400);
        $result = verifyFaceDescriptor($db, $workerId, $descriptor);
        if (($result['reason'] ?? '') === 'no_face') sendResponse(["error" => "no face enrolled"], 404);
        if (!$result['ok']) sendResponse(["error" => faceFailureMessage($result['reason'] ?? '')], 400);
        sendResponse(["message" => "face verified", "verified" => true]);
    }

    // Admin escape hatch: a worker whose face changes (new glasses, big haircut, a bad
    // first enrolment) cannot sign in, so an org admin clears it and they re-enroll at
    // their next login.
    if ($action === 'reset') {
        if ($session['role'] !== 'admin') sendResponse(["error" => "Forbidden"], 403);
        forgetWorkerFaces($db, $workerId);
        writeAudit($db, $session, 'reset_face', 'worker', (int)$workerId, ['organization_id' => workerOrganizationId($db, $workerId)]);
        sendResponse(["message" => "Face reset. The worker will set it again at their next login.", "has_face" => false]);
    }

    sendResponse(["error" => "invalid action"], 400);
} catch (Exception $e) {
    if (!isProductionEnvironment()) {
        sendResponse(["error" => $e->getMessage()], 500);
    }
    error_log('face.php: ' . $e->getMessage());
    sendResponse(["error" => "Something went wrong. Please try again."], 500);
}
