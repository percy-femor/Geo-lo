<?php

function gdAvailable() {
    return function_exists('imagecreatefromstring') && function_exists('imagecreatetruecolor');
}

function loadImageFromBase64($base64) {
    if (!$base64) return null;
    if (!gdAvailable()) return null;
    $parts = explode(',', $base64);
    $data = base64_decode(end($parts));
    if ($data === false) return null;
    return @imagecreatefromstring($data);
}

function computeAHash($img) {
    $w = 8;
    $h = 8;
    $dst = imagecreatetruecolor($w, $h);
    imagecopyresampled($dst, $img, 0, 0, 0, 0, $w, $h, imagesx($img), imagesy($img));
    $sum = 0;
    $vals = [];
    for ($y = 0; $y < $h; $y++) {
        for ($x = 0; $x < $w; $x++) {
            $rgb = imagecolorat($dst, $x, $y);
            $r = ($rgb >> 16) & 0xFF;
            $g = ($rgb >> 8) & 0xFF;
            $b = $rgb & 0xFF;
            $v = intval(($r + $g + $b) / 3);
            $vals[] = $v;
            $sum += $v;
        }
    }
    $avg = $sum / max(1, count($vals));
    $bits = '';
    foreach ($vals as $v) {
        $bits .= ($v >= $avg) ? '1' : '0';
    }
    imagedestroy($dst);
    return $bits;
}

function hammingDistance($a, $b) {
    $len = min(strlen($a), strlen($b));
    $d = 0;
    for ($i = 0; $i < $len; $i++) {
        if ($a[$i] !== $b[$i]) $d++;
    }
    return $d + abs(strlen($a) - strlen($b));
}

function faceImageQuality($img) {
    $w = imagesx($img);
    $h = imagesy($img);
    if ($w < 40 || $h < 40) return 'too_blurry';
    $stepX = max(1, (int)floor($w / 24));
    $stepY = max(1, (int)floor($h / 24));
    $sum = 0;
    $sumSq = 0;
    $n = 0;
    for ($y = 0; $y < $h; $y += $stepY) {
        for ($x = 0; $x < $w; $x += $stepX) {
            $rgb = imagecolorat($img, $x, $y);
            $v = ((($rgb >> 16) & 0xFF) + (($rgb >> 8) & 0xFF) + ($rgb & 0xFF)) / 3;
            $sum += $v;
            $sumSq += $v * $v;
            $n++;
        }
    }
    if ($n < 8) return 'too_blurry';
    $mean = $sum / $n;
    $variance = ($sumSq / $n) - ($mean * $mean);
    if ($mean < 22) return 'too_dark';
    if ($mean > 242) return 'too_bright';
    if ($variance < 90) return 'too_blurry';
    return null;
}

function faceFailureMessage($reason) {
    switch ($reason) {
        case 'too_dark':
            return 'Photo is too dark. Face the camera in better light and try again.';
        case 'too_bright':
            return 'Photo is too bright. Avoid strong backlight and try again.';
        case 'too_blurry':
            return 'Photo is not clear enough. Hold still, fill the frame with your face, and try again.';
        case 'invalid_image':
            return 'Could not read the photo. Try again.';
        case 'no_gd':
            return 'Face check is not available on this server. Ask Geo-Lo to enable the PHP GD extension.';
        case 'no_face':
            return 'Face verification required.';
        case 'mismatch':
        default:
            return 'Face did not match. Face the camera in better light and try again.';
    }
}

function getEnrolledFaceHash($db, $workerId) {
    $stmt = $db->prepare("SELECT phash FROM worker_faces WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1");
    $stmt->execute([$workerId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? $row['phash'] : null;
}

function verifyFaceImage($db, $workerId, $image) {
    if (!gdAvailable()) {
        return ['ok' => false, 'reason' => 'no_gd'];
    }
    $enrolled = getEnrolledFaceHash($db, $workerId);
    if (!$enrolled) {
        return ['ok' => false, 'reason' => 'no_face'];
    }
    $img = loadImageFromBase64($image);
    if (!$img) {
        return ['ok' => false, 'reason' => 'invalid_image'];
    }
    $quality = faceImageQuality($img);
    if ($quality) {
        imagedestroy($img);
        return ['ok' => false, 'reason' => $quality];
    }
    $hash = computeAHash($img);
    imagedestroy($img);
    $dist = hammingDistance($hash, $enrolled);
    if ($dist > 10) {
        return ['ok' => false, 'reason' => 'mismatch', 'distance' => $dist];
    }
    return ['ok' => true, 'distance' => $dist];
}

function enrollFaceImage($db, $workerId, $image) {
    if (!gdAvailable()) return 'no_gd';
    $img = loadImageFromBase64($image);
    if (!$img) return 'invalid_image';
    $quality = faceImageQuality($img);
    if ($quality) {
        imagedestroy($img);
        return $quality;
    }
    $hash = computeAHash($img);
    imagedestroy($img);
    $stmt = $db->prepare("INSERT INTO worker_faces (worker_id, phash) VALUES (?, ?)");
    $stmt->execute([$workerId, $hash]);
    return true;
}
