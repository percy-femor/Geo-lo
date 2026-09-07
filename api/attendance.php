<?php
require_once 'config.php';
require_once 'auth_lib.php';
require_once 'face_lib.php';
require_once 'work_rules.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method === 'POST') {
        $session = requireWorker($db);
        $data = getJsonInput();
        if (!is_array($data) || $data === []) {
            sendResponse(["error" => "Invalid check-in request. Try again with a smaller photo."], 400);
        }
        $workerId = (int)$session['user_id'];

        $required = ['action', 'latitude', 'longitude'];
        foreach ($required as $field) {
            if (!isset($data[$field])) {
                sendResponse(["error" => "Missing required field: $field"], 400);
            }
        }

        $fingerprint = $data['device_fingerprint'] ?? null;
        $stmt = $db->prepare("SELECT id, name, device_bound, device_fingerprint, require_face FROM workers WHERE id = ? AND COALESCE(is_active, 1) = 1");
        $stmt->execute([$workerId]);
        $worker = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$worker) sendResponse(["error" => "Worker not found"], 401);

        if ((int)$worker['device_bound'] === 1 && !empty($worker['device_fingerprint']) && $fingerprint && $worker['device_fingerprint'] !== $fingerprint) {
            logPunchAttempt($db, $workerId, $data['action'], $data, false, 'device mismatch');
            sendResponse(["error" => "This account is bound to another device. Ask an admin to reset it."], 403);
        }

        $accuracy = isset($data['accuracy']) ? (float)$data['accuracy'] : null;
        $gpsError = gpsSanityCheck($db, $workerId, $data['latitude'], $data['longitude'], $accuracy);
        if ($gpsError) {
            logPunchAttempt($db, $workerId, $data['action'], $data, false, $gpsError);
            createAlert($db, 'gps_anomaly', $worker['name'] . ': ' . $gpsError, $workerId, null);
            sendResponse(["error" => $gpsError], 400);
        }

        autoCloseMissedCheckouts($db, $workerId);

        $stmt = $db->prepare("SELECT l.* FROM locations l
            JOIN workers w ON w.organization_id = l.organization_id
            WHERE w.id = ? AND l.is_active = 1");
        $stmt->execute([$workerId]);
        $locations = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $accuracyBonus = $accuracy !== null ? min((float)$accuracy, 800) : 0;
        $withinGeofence = false;
        $validLocation = null;
        $nearestDistance = null;
        foreach ($locations as $location) {
            $distance = calculateDistance(
                $data['latitude'],
                $data['longitude'],
                $location['latitude'],
                $location['longitude']
            );
            if ($nearestDistance === null || $distance < $nearestDistance) {
                $nearestDistance = $distance;
            }
            $radius = (float)$location['radius_meters'] + $accuracyBonus;
            if ($distance <= $radius) {
                $withinGeofence = true;
                $validLocation = $location;
                break;
            }
        }

        $shift = getWorkerShift($db, $workerId);

        if ($data['action'] === 'checkin') {
            $enrolled = getEnrolledFaceHash($db, $workerId);
            $mustFace = gdAvailable() && ($enrolled || (int)$worker['require_face'] === 1);
            if ($mustFace) {
                $image = $data['image'] ?? null;
                if (!$image) {
                    logPunchAttempt($db, $workerId, 'checkin', $data, false, 'face required');
                    sendResponse(["error" => "Face verification required"], 400);
                }
                if ($enrolled) {
                    $face = verifyFaceImage($db, $workerId, $image);
                    if (!$face['ok']) {
                        logPunchAttempt($db, $workerId, 'checkin', $data, false, 'face ' . $face['reason']);
                        createAlert($db, 'face_fail', $worker['name'] . ' failed face verification', $workerId, null);
                        sendResponse(["error" => faceFailureMessage($face['reason'] ?? '')], 400);
                    }
                } else {
                    $enrolledOk = enrollFaceImage($db, $workerId, $image);
                    if ($enrolledOk !== true) {
                        sendResponse(["error" => faceFailureMessage(is_string($enrolledOk) ? $enrolledOk : 'invalid_image')], 400);
                    }
                }
            }

            if (!$withinGeofence || !$validLocation) {
                logPunchAttempt($db, $workerId, 'checkin', $data, false, 'outside geofence');
                sendResponse([
                    "success" => false,
                    "message" => "You are outside all workplace areas. Please move to a designated work location."
                ], 400);
            }

            $open = $db->prepare("SELECT id FROM attendance WHERE worker_id = ? AND check_out IS NULL LIMIT 1");
            $open->execute([$workerId]);
            if ($open->fetch()) {
                sendResponse(["error" => "You already have an open check-in. Check out first."], 400);
            }

            $status = classifyAttendanceStatus($shift, date('Y-m-d H:i:s'));
            $stmt = $db->prepare("INSERT INTO attendance (worker_id, location_id, check_in, check_in_lat, check_in_lng, status, accuracy_meters, device_fingerprint) VALUES (?, ?, NOW(), ?, ?, ?, ?, ?)");
            $stmt->execute([
                $workerId,
                $validLocation['id'],
                $data['latitude'],
                $data['longitude'],
                $status,
                $accuracy !== null ? (int)$accuracy : null,
                $fingerprint
            ]);
            $attendanceId = (int)$db->lastInsertId();
            if ($status === 'late') {
                createAlert($db, 'late', $worker['name'] . ' checked in late', $workerId, $attendanceId);
            }
            logPunchAttempt($db, $workerId, 'checkin', $data, true, 'ok');
            writeAudit($db, $session, 'checkin', 'attendance', $attendanceId, ['status' => $status, 'location_id' => $validLocation['id']]);
            sendResponse(["success" => true, "message" => $status === 'late' ? "Checked in (late)" : "Check-in successful", "status" => $status]);
        }

        if ($data['action'] === 'checkout') {
            $stmt = $db->prepare("SELECT * FROM attendance WHERE worker_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1");
            $stmt->execute([$workerId]);
            $attendance = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$attendance) {
                sendResponse(["error" => "No active check-in found"], 400);
            }
            $outside = $withinGeofence ? 0 : 1;
            $checkOutAt = date('Y-m-d H:i:s');
            $overtime = computeOvertimeMinutes($shift, $attendance['check_in'], $checkOutAt);
            $upd = $db->prepare("UPDATE attendance SET check_out = ?, check_out_lat = ?, check_out_lng = ?, overtime_minutes = ?, outside_geofence = ? WHERE id = ?");
            $upd->execute([
                $checkOutAt,
                $data['latitude'],
                $data['longitude'],
                $overtime,
                $outside,
                $attendance['id']
            ]);
            if ($outside) {
                createAlert($db, 'offsite_checkout', $worker['name'] . ' checked out outside the work area', $workerId, $attendance['id']);
            }
            logPunchAttempt($db, $workerId, 'checkout', $data, true, $outside ? 'outside geofence' : 'ok');
            writeAudit($db, $session, 'checkout', 'attendance', $attendance['id'], ['overtime_minutes' => $overtime, 'outside_geofence' => $outside]);
            sendResponse(["success" => true, "message" => "Check-out successful", "overtime_minutes" => $overtime]);
        }

        sendResponse(["error" => "Invalid action"], 400);
    }

    if ($method === 'PUT') {
        $session = requireOrgAdmin($db);
        $data = getJsonInput();
        if (empty($data['id'])) sendResponse(["error" => "Attendance ID required"], 400);
        if (empty($data['reason']) || strlen(trim($data['reason'])) < 3) {
            sendResponse(["error" => "A correction reason is required"], 400);
        }
        $stmt = $db->prepare("SELECT a.* FROM attendance a JOIN workers w ON w.id = a.worker_id WHERE a.id = ? AND w.organization_id = ?");
        $stmt->execute([$data['id'], orgId($session)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) sendResponse(["error" => "Record not found"], 404);

        $fields = [];
        $values = [];
        if (!empty($data['check_in'])) { $fields[] = "check_in = ?"; $values[] = $data['check_in']; }
        if (array_key_exists('check_out', $data)) { $fields[] = "check_out = ?"; $values[] = $data['check_out'] ?: null; }
        if (isset($data['status'])) { $fields[] = "status = ?"; $values[] = $data['status']; }
        $fields[] = "is_manual = 1";
        $fields[] = "corrected_by = ?";
        $values[] = $session['user_id'];
        $fields[] = "notes = ?";
        $values[] = trim($data['reason']);
        $fields[] = "missed_checkout = 0";

        if (empty($data['check_in']) && !array_key_exists('check_out', $data) && empty($data['status'])) {
            sendResponse(["error" => "Nothing to correct"], 400);
        }

        $checkIn = $data['check_in'] ?? $row['check_in'];
        $checkOut = array_key_exists('check_out', $data) ? ($data['check_out'] ?: null) : $row['check_out'];
        if ($checkIn && $checkOut) {
            $shift = getWorkerShift($db, $row['worker_id']);
            $fields[] = "overtime_minutes = ?";
            $values[] = computeOvertimeMinutes($shift, $checkIn, $checkOut);
        }

        $sql = "UPDATE attendance SET " . implode(', ', $fields) . " WHERE id = ?";
        $values[] = $data['id'];
        $db->prepare($sql)->execute($values);
        writeAudit($db, $session, 'correct', 'attendance', (int)$data['id'], [
            'reason' => $data['reason'],
            'before' => $row,
            'after' => ['check_in' => $checkIn, 'check_out' => $checkOut]
        ]);
        sendResponse(["message" => "Attendance corrected"]);
    }

    sendResponse(["error" => "Method not allowed"], 405);
} catch (Throwable $e) {
    sendResponse(["error" => "Check-in failed: " . $e->getMessage()], 500);
}
