<?php

function getWorkerShift($db, $workerId) {
    $stmt = $db->prepare("SELECT s.* FROM workers w LEFT JOIN shifts s ON s.id = w.shift_id WHERE w.id = ? LIMIT 1");
    $stmt->execute([$workerId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || empty($row['id'])) return null;
    return $row;
}

function shiftWorkDays($shift) {
    if (!$shift || empty($shift['work_days'])) return [1, 2, 3, 4, 5];
    return array_map('intval', array_filter(explode(',', $shift['work_days']), 'strlen'));
}

function isShiftWorkDay($shift, $date = null) {
    $ts = $date ? strtotime($date) : time();
    $dow = (int)date('w', $ts);
    return in_array($dow, shiftWorkDays($shift), true);
}

function shiftExpectedMinutes($shift) {
    if (!$shift) return 8 * 60;
    $start = strtotime('1970-01-01 ' . $shift['start_time']);
    $end = strtotime('1970-01-01 ' . $shift['end_time']);
    if ($end <= $start) $end += 86400;
    $span = (int)round(($end - $start) / 60);
    $break = (int)($shift['break_minutes'] ?? 0);
    return max(1, $span - $break);
}

function classifyAttendanceStatus($shift, $checkInDatetime) {
    if (!$shift) return 'present';
    $day = date('Y-m-d', strtotime($checkInDatetime));
    if (!isShiftWorkDay($shift, $day)) return 'present';
    $start = strtotime($day . ' ' . $shift['start_time']);
    $grace = (int)($shift['late_grace_minutes'] ?? 0);
    $limit = $start + ($grace * 60);
    return strtotime($checkInDatetime) > $limit ? 'late' : 'present';
}

function computeOvertimeMinutes($shift, $checkIn, $checkOut) {
    if (!$checkIn || !$checkOut) return 0;
    $worked = max(0, (int)round((strtotime($checkOut) - strtotime($checkIn)) / 60));
    $break = (int)($shift['break_minutes'] ?? 0);
    $net = max(0, $worked - $break);
    $threshold = (int)($shift['overtime_after_minutes'] ?? 0);
    if ($threshold <= 0) $threshold = shiftExpectedMinutes($shift);
    return max(0, $net - $threshold);
}

function autoCloseMissedCheckouts($db, $workerId = null, $orgId = null) {
    $sql = "SELECT a.*, w.name, w.shift_id FROM attendance a JOIN workers w ON w.id = a.worker_id WHERE a.check_out IS NULL AND DATE(a.check_in) < CURDATE()";
    $params = [];
    if ($workerId) {
        $sql .= " AND a.worker_id = ?";
        $params[] = $workerId;
    }
    if ($orgId) {
        $sql .= " AND w.organization_id = ?";
        $params[] = $orgId;
    }
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $open = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($open as $row) {
        $shift = $row['shift_id'] ? getWorkerShift($db, $row['worker_id']) : null;
        $day = date('Y-m-d', strtotime($row['check_in']));
        $closeAt = $shift ? ($day . ' ' . $shift['end_time']) : ($day . ' 23:59:00');
        if (strtotime($closeAt) <= strtotime($row['check_in'])) {
            $closeAt = date('Y-m-d H:i:s', strtotime($row['check_in'] . ' +8 hours'));
        }
        $overtime = computeOvertimeMinutes($shift, $row['check_in'], $closeAt);
        $upd = $db->prepare("UPDATE attendance SET check_out = ?, overtime_minutes = ?, missed_checkout = 1, notes = COALESCE(NULLIF(notes, ''), 'Auto-closed: missed checkout') WHERE id = ?");
        $upd->execute([$closeAt, $overtime, $row['id']]);
        createAlert($db, 'missed_checkout', ($row['name'] ?? 'Worker') . ' missed checkout on ' . $day, $row['worker_id'], $row['id']);
        writeAudit($db, ['role' => 'system', 'user_id' => null, 'organization_id' => workerOrganizationId($db, $row['worker_id'])], 'auto_close', 'attendance', $row['id'], ['check_out' => $closeAt]);
    }
    return count($open);
}

function refreshAbsenceAlerts($db, $date = null, $orgId = null) {
    $date = $date ?: date('Y-m-d');
    $dow = (int)date('w', strtotime($date));
    $sql = "SELECT w.id, w.name, s.start_time, s.late_grace_minutes, s.work_days FROM workers w LEFT JOIN shifts s ON s.id = w.shift_id WHERE COALESCE(w.is_active, 1) = 1";
    $params = [];
    if ($orgId) {
        $sql .= " AND w.organization_id = ?";
        $params[] = $orgId;
    }
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $workers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $created = 0;
    foreach ($workers as $worker) {
        $days = $worker['work_days'] ? array_map('intval', explode(',', $worker['work_days'])) : [1, 2, 3, 4, 5];
        if (!in_array($dow, $days, true)) continue;
        $start = $worker['start_time'] ?: '08:00:00';
        $grace = (int)($worker['late_grace_minutes'] ?? 10);
        $cutoff = strtotime($date . ' ' . $start) + ($grace * 60) + 3600;
        if (time() < $cutoff && $date === date('Y-m-d')) continue;
        $att = $db->prepare("SELECT id FROM attendance WHERE worker_id = ? AND DATE(check_in) = ? LIMIT 1");
        $att->execute([$worker['id'], $date]);
        if ($att->fetch()) continue;
        createAlert($db, 'absent', $worker['name'] . ' has no check-in on ' . $date, $worker['id'], null);
        $created++;
    }
    return $created;
}

function gpsSanityCheck($db, $workerId, $lat, $lng, $accuracy) {
    if ($accuracy !== null && $accuracy > 2500) {
        return 'GPS signal is unusable (±' . (int)$accuracy . 'm). Enable location services and try again.';
    }
    $stmt = $db->prepare("SELECT check_in, check_in_lat, check_in_lng, check_out, check_out_lat, check_out_lng FROM attendance WHERE worker_id = ? ORDER BY id DESC LIMIT 1");
    $stmt->execute([$workerId]);
    $last = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$last) return null;
    $prevLat = $last['check_out_lat'] ?: $last['check_in_lat'];
    $prevLng = $last['check_out_lng'] ?: $last['check_in_lng'];
    $prevTime = $last['check_out'] ?: $last['check_in'];
    if (!$prevLat || !$prevLng || !$prevTime) return null;
    $distance = calculateDistance($lat, $lng, $prevLat, $prevLng);
    $hours = max(0.02, (time() - strtotime($prevTime)) / 3600);
    $kmh = ($distance / 1000) / $hours;
    if ($kmh > 180) {
        return 'Impossible travel detected from the last punch. Clock-in was blocked.';
    }
    return null;
}
