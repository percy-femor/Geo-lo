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
    $session = requireAuth($db, ['admin', 'worker']);
    $data = getJsonInput();
    $action = $data['action'] ?? '';
    $workerId = $data['worker_id'] ?? null;
    if ($session['role'] === 'worker') {
        $workerId = $session['user_id'];
    }
    if ($session['role'] === 'admin') {
        $session = attachAdminContext($db, $session);
        if ($session['privilege'] === 'super_admin') {
            sendResponse(["error" => "Organization admins enroll worker faces from their console"], 403);
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
        $image = $data['image'] ?? null;
        if (!$image) sendResponse(["error" => "worker_id and image required"], 400);
        $enrolled = enrollFaceImage($db, $workerId, $image);
        if ($enrolled !== true) {
            sendResponse(["error" => faceFailureMessage(is_string($enrolled) ? $enrolled : 'invalid_image')], 400);
        }
        writeAudit($db, $session, 'enroll_face', 'worker', (int)$workerId, ['organization_id' => workerOrganizationId($db, $workerId)]);
        sendResponse(["message" => "Face enrolled"]);
    }

    if ($action === 'verify') {
        $image = $data['image'] ?? null;
        if (!$image) sendResponse(["error" => "worker_id and image required"], 400);
        $result = verifyFaceImage($db, $workerId, $image);
        if (($result['reason'] ?? '') === 'no_face') sendResponse(["error" => "no face enrolled"], 404);
        if (!$result['ok']) sendResponse(["error" => faceFailureMessage($result['reason'] ?? '')], 400);
        sendResponse(["message" => "face verified", "verified" => true]);
    }

    sendResponse(["error" => "invalid action"], 400);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
