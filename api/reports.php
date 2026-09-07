<?php
require_once 'config.php';
require_once 'auth_lib.php';
require_once 'work_rules.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

function hoursFromTimediff($value) {
    if (!$value) return 0;
    $parts = explode(':', $value);
    if (count($parts) < 2) return 0;
    return (int)$parts[0] + ((int)$parts[1] / 60);
}

function sendCsv($filename, $headers, $rows) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    $out = fopen('php://output', 'w');
    fprintf($out, chr(0xEF) . chr(0xBB) . chr(0xBF));
    fputcsv($out, $headers);
    foreach ($rows as $row) fputcsv($out, $row);
    fclose($out);
    exit();
}

try {
    if ($method !== 'GET') {
        sendResponse(["error" => "Method not allowed"], 405);
    }

    $session = requireAuth($db, ['admin', 'worker']);
    $reportType = $_GET['type'] ?? 'daily';
    $isAdmin = $session['role'] === 'admin';
    $oid = null;

    if (in_array($reportType, ['live', 'payroll', 'audit', 'exceptions'], true) && !$isAdmin) {
        sendResponse(["error" => "Forbidden"], 403);
    }

    if ($isAdmin) {
        $session = requireOrgAdmin($db);
        $oid = orgId($session);
        autoCloseMissedCheckouts($db, null, $oid);
        refreshAbsenceAlerts($db, null, $oid);
    }

    if ($reportType === 'daily') {
        $email = $_GET['email'] ?? null;
        if (!$isAdmin) {
            $stmt = $db->prepare("SELECT email FROM workers WHERE id = ?");
            $stmt->execute([$session['user_id']]);
            $email = $stmt->fetchColumn();
        }
        if ($email) {
            $sql = "
                SELECT w.name, w.employee_id, l.name as location_name, a.id, a.worker_id,
                    a.check_in, a.check_out, TIMEDIFF(a.check_out, a.check_in) as hours_worked,
                    a.status, a.overtime_minutes, a.missed_checkout, a.outside_geofence, a.is_manual, a.notes
                FROM attendance a
                JOIN workers w ON a.worker_id = w.id
                JOIN locations l ON a.location_id = l.id
                WHERE DATE(a.check_in) = CURDATE() AND w.email = ?
            ";
            $params = [$email];
            if ($oid) {
                $sql .= " AND w.organization_id = ?";
                $params[] = $oid;
            }
            $sql .= " ORDER BY a.check_in DESC";
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
        } else {
            $stmt = $db->prepare("
                SELECT w.name, w.employee_id, l.name as location_name, a.id, a.worker_id,
                    a.check_in, a.check_out, TIMEDIFF(a.check_out, a.check_in) as hours_worked,
                    a.status, a.overtime_minutes, a.missed_checkout, a.outside_geofence, a.is_manual, a.notes
                FROM attendance a
                JOIN workers w ON a.worker_id = w.id
                JOIN locations l ON a.location_id = l.id
                WHERE DATE(a.check_in) = CURDATE() AND w.organization_id = ?
                ORDER BY a.check_in DESC
            ");
            $stmt->execute([$oid]);
        }
        sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    if ($reportType === 'monthly') {
        $workerId = $_GET['worker_id'] ?? null;
        $month = $_GET['month'] ?? date('Y-m');
        if (!$isAdmin) $workerId = $session['user_id'];
        if (!$workerId) sendResponse(["error" => "Invalid report type or missing worker ID"], 400);
        if ($oid) assertOrgRow($db, 'workers', $workerId, $oid, 'Worker');
        $stmt = $db->prepare("
            SELECT DATE(check_in) as date, l.name as location_name, check_in, check_out,
                TIMEDIFF(check_out, check_in) as hours_worked, status, overtime_minutes, missed_checkout, is_manual, notes
            FROM attendance
            JOIN locations l ON attendance.location_id = l.id
            WHERE worker_id = ? AND DATE_FORMAT(check_in, '%Y-%m') = ?
            ORDER BY check_in
        ");
        $stmt->execute([$workerId, $month]);
        sendResponse($stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    if ($reportType === 'live') {
        $onSite = $db->prepare("
            SELECT w.id, w.name, w.employee_id, l.name AS location_name, a.check_in, a.status
            FROM attendance a
            JOIN workers w ON w.id = a.worker_id
            JOIN locations l ON l.id = a.location_id
            WHERE a.check_out IS NULL AND w.organization_id = ?
            ORDER BY a.check_in
        ");
        $onSite->execute([$oid]);
        $onSite = $onSite->fetchAll(PDO::FETCH_ASSOC);

        $late = $db->prepare("
            SELECT w.id, w.name, w.employee_id, a.check_in, a.status
            FROM attendance a JOIN workers w ON w.id = a.worker_id
            WHERE DATE(a.check_in) = CURDATE() AND a.status = 'late' AND w.organization_id = ?
            ORDER BY a.check_in
        ");
        $late->execute([$oid]);
        $late = $late->fetchAll(PDO::FETCH_ASSOC);

        $missed = $db->prepare("
            SELECT w.id, w.name, w.employee_id, a.check_in, a.check_out, a.id AS attendance_id
            FROM attendance a JOIN workers w ON w.id = a.worker_id
            WHERE a.missed_checkout = 1 AND a.check_in >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND w.organization_id = ?
            ORDER BY a.check_in DESC
        ");
        $missed->execute([$oid]);
        $missed = $missed->fetchAll(PDO::FETCH_ASSOC);

        $workersStmt = $db->prepare("SELECT w.id, w.name, w.employee_id, s.start_time, s.work_days FROM workers w LEFT JOIN shifts s ON s.id = w.shift_id WHERE COALESCE(w.is_active,1)=1 AND w.organization_id = ?");
        $workersStmt->execute([$oid]);
        $workers = $workersStmt->fetchAll(PDO::FETCH_ASSOC);
        $presentStmt = $db->prepare("SELECT DISTINCT a.worker_id FROM attendance a JOIN workers w ON w.id = a.worker_id WHERE DATE(a.check_in) = CURDATE() AND w.organization_id = ?");
        $presentStmt->execute([$oid]);
        $presentIds = $presentStmt->fetchAll(PDO::FETCH_COLUMN);
        $dow = (int)date('w');
        $notArrived = [];
        foreach ($workers as $worker) {
            $days = $worker['work_days'] ? array_map('intval', explode(',', $worker['work_days'])) : [1,2,3,4,5];
            if (!in_array($dow, $days, true)) continue;
            if (in_array((string)$worker['id'], array_map('strval', $presentIds), true)) continue;
            $notArrived[] = $worker;
        }

        sendResponse([
            "on_site" => $onSite,
            "late" => $late,
            "not_arrived" => $notArrived,
            "missed_checkout" => $missed,
            "counts" => [
                "on_site" => count($onSite),
                "late" => count($late),
                "not_arrived" => count($notArrived),
                "missed_checkout" => count($missed)
            ]
        ]);
    }

    if ($reportType === 'payroll') {
        $from = $_GET['from'] ?? date('Y-m-01');
        $to = $_GET['to'] ?? date('Y-m-d');
        $stmt = $db->prepare("
            SELECT w.id, w.name, w.employee_id,
                COUNT(a.id) AS punches,
                SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late_count,
                SUM(CASE WHEN a.missed_checkout = 1 THEN 1 ELSE 0 END) AS missed_checkout_count,
                SUM(TIMESTAMPDIFF(MINUTE, a.check_in, COALESCE(a.check_out, a.check_in))) AS worked_minutes,
                SUM(COALESCE(a.overtime_minutes, 0)) AS overtime_minutes
            FROM workers w
            LEFT JOIN attendance a ON a.worker_id = w.id AND DATE(a.check_in) BETWEEN ? AND ?
            WHERE COALESCE(w.is_active, 1) = 1 AND w.organization_id = ?
            GROUP BY w.id, w.name, w.employee_id
            ORDER BY w.name
        ");
        $stmt->execute([$from, $to, $oid]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            $mins = (int)($row['worked_minutes'] ?? 0);
            $ot = (int)($row['overtime_minutes'] ?? 0);
            $row['regular_hours'] = round(max(0, $mins - $ot) / 60, 2);
            $row['overtime_hours'] = round($ot / 60, 2);
            $row['total_hours'] = round($mins / 60, 2);
        }
        unset($row);

        $absences = [];
        $periodStart = new DateTime($from);
        $periodEnd = new DateTime($to);
        $workerShiftsStmt = $db->prepare("SELECT w.id, w.name, s.work_days FROM workers w LEFT JOIN shifts s ON s.id = w.shift_id WHERE COALESCE(w.is_active,1)=1 AND w.organization_id = ?");
        $workerShiftsStmt->execute([$oid]);
        $workerShifts = $workerShiftsStmt->fetchAll(PDO::FETCH_ASSOC);
        $punchDaysStmt = $db->prepare("SELECT a.worker_id, DATE(a.check_in) d FROM attendance a JOIN workers w ON w.id = a.worker_id WHERE DATE(a.check_in) BETWEEN ? AND ? AND w.organization_id = ?");
        $punchDaysStmt->execute([$from, $to, $oid]);
        $punched = [];
        foreach ($punchDaysStmt as $p) {
            $punched[$p['worker_id'] . '|' . $p['d']] = true;
        }
        foreach ($workerShifts as $worker) {
            $days = $worker['work_days'] ? array_map('intval', explode(',', $worker['work_days'])) : [1,2,3,4,5];
            $absent = 0;
            for ($d = clone $periodStart; $d <= $periodEnd; $d->modify('+1 day')) {
                if ((int)$d->format('w') === 0 || (int)$d->format('w') === 6) {
                    if (!in_array((int)$d->format('w'), $days, true)) continue;
                } elseif (!in_array((int)$d->format('w'), $days, true)) continue;
                $key = $worker['id'] . '|' . $d->format('Y-m-d');
                if (empty($punched[$key])) $absent++;
            }
            $absences[$worker['id']] = $absent;
        }
        foreach ($rows as &$row) {
            $row['absent_days'] = $absences[$row['id']] ?? 0;
        }
        unset($row);

        if (($_GET['format'] ?? '') === 'csv') {
            $csvRows = [];
            foreach ($rows as $row) {
                $csvRows[] = [$row['employee_id'], $row['name'], $row['regular_hours'], $row['overtime_hours'], $row['total_hours'], $row['late_count'], $row['absent_days'], $row['missed_checkout_count']];
            }
            sendCsv("payroll-$from-to-$to.csv", ['Employee ID', 'Name', 'Regular hours', 'Overtime hours', 'Total hours', 'Late', 'Absent days', 'Missed checkouts'], $csvRows);
        }
        sendResponse(["from" => $from, "to" => $to, "rows" => $rows]);
    }

    if ($reportType === 'audit') {
        $stmt = $db->prepare("SELECT * FROM audit_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200");
        $stmt->execute([$oid]);
        sendResponse(decorateAuditRows($db, $stmt->fetchAll(PDO::FETCH_ASSOC)));
    }

    sendResponse(["error" => "Invalid report type or missing worker ID"], 400);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
