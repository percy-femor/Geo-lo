<?php
require_once 'config.php';
require_once 'auth_lib.php';

$database = new Database();
$db = $database->getConnection();
$method = $_SERVER['REQUEST_METHOD'];

// A code is valid for 15 minutes and can be typed wrong 5 times before it dies.
const RESET_CODE_TTL_SECONDS = 900;
const RESET_MAX_ATTEMPTS = 5;

/**
 * Which account owns this email? Workers and admins live in separate tables, so
 * the match decides which portal the reset belongs to. Admins can have a
 * separate recovery inbox (the owner signs in as boss@geo-lo, which is not a
 * real mailbox).
 */
function findResetAccount($db, $email) {
    $email = trim((string)$email);
    if ($email === '') return null;

    $stmt = $db->prepare("SELECT id, name, email FROM workers WHERE LOWER(email) = LOWER(?) AND COALESCE(is_active, 1) = 1 LIMIT 1");
    $stmt->execute([$email]);
    $worker = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($worker) {
        return [
            'type' => 'worker',
            'id' => (int)$worker['id'],
            'name' => $worker['name'],
            'deliver_to' => $worker['email'],
        ];
    }

    $stmt = $db->prepare("SELECT id, name, email, privilege, recovery_email FROM admins WHERE LOWER(email) = LOWER(?) AND COALESCE(is_active, 1) = 1 LIMIT 1");
    $stmt->execute([$email]);
    $admin = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$admin) return null;

    $deliverTo = trim((string)($admin['recovery_email'] ?? ''));
    return [
        'type' => 'admin',
        'id' => (int)$admin['id'],
        'name' => $admin['name'],
        'deliver_to' => $deliverTo !== '' ? $deliverTo : $admin['email'],
    ];
}

/** Hide most of an address so the response does not leak the recovery inbox. */
function maskEmail($email) {
    $at = strpos((string)$email, '@');
    if ($at === false || $at === 0) return (string)$email;
    return substr($email, 0, 1) . str_repeat('•', max(1, $at - 1)) . substr($email, $at);
}

function resetCodeEmailHtml($name, $code) {
    $safeName = htmlspecialchars($name !== '' ? $name : 'there', ENT_QUOTES, 'UTF-8');
    $safeCode = htmlspecialchars($code, ENT_QUOTES, 'UTF-8');
    return <<<HTML
<div style="font-family:Poppins,Arial,sans-serif;max-width:480px;margin:0 auto;color:#10251b">
  <h2 style="color:#16a34a;margin-bottom:8px">Reset your Geo-Lo password</h2>
  <p>Hi {$safeName},</p>
  <p>Use this code to set a new password. It expires in 15 minutes.</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;background:#eafaf1;border:1px solid #bbf7d0;border-radius:12px;padding:16px;text-align:center;color:#15803d">{$safeCode}</p>
  <p style="color:#5c7d6e;font-size:13px">If you did not ask for this, you can ignore this email — your current password still works.</p>
</div>
HTML;
}

/** Drop every live session for an account: a password change ends other logins. */
function revokeAccountSessions($db, $account) {
    $role = $account['type'] === 'admin' ? 'admin' : 'worker';
    $db->prepare("DELETE FROM sessions WHERE role = ? AND user_id = ?")->execute([$role, $account['id']]);
}

try {
    if ($method !== 'POST') {
        sendResponse(["error" => "Method not allowed"], 405);
    }

    $data = getJsonInput() ?: [];
    $action = $data['action'] ?? '';
    $email = trim((string)($data['email'] ?? ''));

    if ($action === 'request') {
        if ($email === '') {
            sendResponse(["error" => "Email required"], 400);
        }
        $account = findResetAccount($db, $email);
        if (!$account) {
            sendResponse(["error" => "We could not find an account with that email."], 404);
        }

        // Only the newest code should work, so retire any earlier one.
        $db->prepare("UPDATE password_reset_codes SET used = 1 WHERE account_type = ? AND account_id = ? AND used = 0")
            ->execute([$account['type'], $account['id']]);

        $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $stmt = $db->prepare("INSERT INTO password_reset_codes (account_type, account_id, email, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)");
        $stmt->execute([
            $account['type'],
            $account['id'],
            $account['deliver_to'],
            password_hash($code, PASSWORD_DEFAULT),
            date('Y-m-d H:i:s', time() + RESET_CODE_TTL_SECONDS)
        ]);

        geoloSendMail($account['deliver_to'], 'Your Geo-Lo password reset code', resetCodeEmailHtml($account['name'], $code));

        // The code only ever travels by email — never back to the browser.
        sendResponse([
            "message" => "If that email is registered, a 6-digit code has been sent to " . maskEmail($account['deliver_to']) . "."
        ]);
    }

    if ($action === 'confirm') {
        $code = trim((string)($data['code'] ?? ''));
        $newPassword = (string)($data['new_password'] ?? '');
        if ($email === '' || $code === '' || $newPassword === '') {
            sendResponse(["error" => "Email, code and a new password are required"], 400);
        }
        $account = findResetAccount($db, $email);
        if (!$account) {
            sendResponse(["error" => "We could not find an account with that email."], 404);
        }

        $minLength = $account['type'] === 'admin' ? 8 : 6;
        if (strlen($newPassword) < $minLength) {
            sendResponse(["error" => "The new password must be at least {$minLength} characters."], 400);
        }

        $stmt = $db->prepare("SELECT id, code_hash, attempts, used, expires_at FROM password_reset_codes WHERE account_type = ? AND account_id = ? AND used = 0 ORDER BY id DESC LIMIT 1");
        $stmt->execute([$account['type'], $account['id']]);
        $reset = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$reset) {
            sendResponse(["error" => "Request a new reset code."], 400);
        }
        if (strtotime($reset['expires_at']) < time()) {
            sendResponse(["error" => "That code has expired. Request a new one."], 400);
        }
        if ((int)$reset['attempts'] >= RESET_MAX_ATTEMPTS) {
            sendResponse(["error" => "Too many incorrect attempts. Request a new code."], 429);
        }
        if (!password_verify($code, $reset['code_hash'])) {
            $db->prepare("UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?")->execute([$reset['id']]);
            sendResponse(["error" => "That code is not correct."], 400);
        }

        $hash = password_hash($newPassword, PASSWORD_DEFAULT);
        if ($account['type'] === 'admin') {
            $db->prepare("UPDATE admins SET password_hash = ?, must_change_password = 0, password_changed_at = NOW() WHERE id = ?")
                ->execute([$hash, $account['id']]);
        } else {
            // Workers sign in with pin_hash, so both columns must move together.
            $db->prepare("UPDATE workers SET pin_hash = ?, password_hash = ? WHERE id = ?")
                ->execute([$hash, $hash, $account['id']]);
        }
        $db->prepare("UPDATE password_reset_codes SET used = 1 WHERE id = ?")->execute([$reset['id']]);
        revokeAccountSessions($db, $account);

        sendResponse(["message" => "Your password has been updated. You can sign in now."]);
    }

    sendResponse(["error" => "Invalid action"], 400);
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
