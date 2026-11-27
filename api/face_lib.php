<?php

/**
 * Face matching.
 *
 * The browser (frontend/face.js, using face-api.js) finds the face in the camera
 * frame, aligns it and turns it into a 128-value embedding, then posts that embedding
 * here. Two shots of the same face land close together in Euclidean space; two
 * different faces land far apart. That is the whole comparison — no image ever reaches
 * the server, which is why this works far better than hashing the raw pixels did.
 *
 * FACE_MATCH_THRESHOLD is the well-known balanced cut-off for this model: strict
 * enough to reject a different person, tolerant of lighting and slight angle changes.
 */
const FACE_DESCRIPTOR_LENGTH = 128;
const FACE_MATCH_THRESHOLD = 0.5;
const FACE_ENGINE = 'face-api-128';

/**
 * Accept a descriptor as a JSON string or a decoded array and return it as a clean
 * list of 128 floats, or null when it is missing, the wrong length or not numeric.
 */
function normalizeFaceDescriptor($value) {
    if (is_string($value)) {
        $decoded = json_decode($value, true);
        $value = is_array($decoded) ? $decoded : null;
    }
    if (!is_array($value) || count($value) !== FACE_DESCRIPTOR_LENGTH) return null;
    $out = [];
    foreach ($value as $v) {
        if (!is_numeric($v)) return null;
        $f = (float)$v;
        if (!is_finite($f)) return null;
        $out[] = $f;
    }
    return $out;
}

function faceDescriptorDistance(array $a, array $b) {
    $sum = 0.0;
    $n = min(count($a), count($b));
    for ($i = 0; $i < $n; $i++) {
        $d = $a[$i] - $b[$i];
        $sum += $d * $d;
    }
    return sqrt($sum);
}

// The most recent face on file for a worker, or null when they have none yet.
function getEnrolledFaceDescriptor($db, $workerId) {
    $stmt = $db->prepare("SELECT descriptor FROM worker_faces
        WHERE worker_id = ? AND descriptor IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1");
    $stmt->execute([(int)$workerId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    return normalizeFaceDescriptor($row['descriptor']);
}

function workerHasFace($db, $workerId) {
    $stmt = $db->prepare("SELECT id FROM worker_faces WHERE worker_id = ? AND descriptor IS NOT NULL LIMIT 1");
    $stmt->execute([(int)$workerId]);
    return (bool)$stmt->fetch();
}

// Store a worker's face. Re-enrolling simply adds a newer row; reads always take the
// latest, so a reset-then-enroll cycle needs no delete.
function enrollFaceDescriptor($db, $workerId, $descriptor) {
    $normalized = normalizeFaceDescriptor($descriptor);
    if ($normalized === null) return 'invalid_face';
    $stmt = $db->prepare("INSERT INTO worker_faces (worker_id, descriptor, engine) VALUES (?, ?, ?)");
    $stmt->execute([(int)$workerId, json_encode($normalized), FACE_ENGINE]);
    return true;
}

function verifyFaceDescriptor($db, $workerId, $descriptor) {
    $enrolled = getEnrolledFaceDescriptor($db, $workerId);
    if (!$enrolled) return ['ok' => false, 'reason' => 'no_face'];
    $candidate = normalizeFaceDescriptor($descriptor);
    if ($candidate === null) return ['ok' => false, 'reason' => 'invalid_face'];
    $distance = faceDescriptorDistance($candidate, $enrolled);
    if ($distance > FACE_MATCH_THRESHOLD) {
        return ['ok' => false, 'reason' => 'mismatch', 'distance' => $distance];
    }
    return ['ok' => true, 'distance' => $distance];
}

function forgetWorkerFaces($db, $workerId) {
    $db->prepare("DELETE FROM worker_faces WHERE worker_id = ?")->execute([(int)$workerId]);
}

function faceFailureMessage($reason) {
    switch ($reason) {
        case 'no_face':
        case 'invalid_face':
            return 'No face detected. Look straight at the camera in good light and keep your whole face in the frame.';
        case 'multiple_faces':
            return 'More than one face is visible. Make sure only you are in front of the camera.';
        case 'model_error':
            return 'Face recognition could not start on this device. Check your connection and try again.';
        case 'challenge_expired':
            return 'This sign-in took too long. Enter your details again.';
        case 'mismatch':
        default:
            return 'That face did not match the one on file. Face the camera in good light and try again, or ask your admin to reset your face.';
    }
}
