<?php
require_once 'config.php';

$database = new Database();
$db = $database->getConnection();

$method = $_SERVER['REQUEST_METHOD'];

function generateToken($length = 32) {
    return bin2hex(random_bytes($length));
}

try {
    if ($method === 'POST') {
        $data = getJsonInput();
        $action = $data['action'] ?? '';
        if ($action === 'request') {
            $email = $data['email'] ?? '';
            if (!$email) {
                sendResponse(["error" => "Email required"], 400);
            }
            $stmt = $db->prepare("SELECT id FROM workers WHERE email = ? AND COALESCE(is_active, 1) = 1");
            $stmt->execute([$email]);
            $worker = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$worker) {
                sendResponse(["error" => "Worker not found"], 404);
            }
            try {
                $db->query("SELECT id FROM password_resets LIMIT 1");
            } catch (Exception $e) {
                $db->exec("CREATE TABLE IF NOT EXISTS password_resets (id INT AUTO_INCREMENT PRIMARY KEY, worker_id INT NOT NULL, token_hash VARCHAR(255) NOT NULL, expires_at DATETIME NOT NULL, used BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE)");
            }
            $token = generateToken(16);
            $tokenHash = password_hash($token, PASSWORD_DEFAULT);
            $expires = date('Y-m-d H:i:s', time() + 3600);
            $stmt = $db->prepare("INSERT INTO password_resets (worker_id, token_hash, expires_at) VALUES (?, ?, ?)");
            $stmt->execute([$worker['id'], $tokenHash, $expires]);
            sendResponse(["message" => "Reset token generated", "token" => $token]);
        } elseif ($action === 'confirm') {
            $token = $data['token'] ?? '';
            $email = $data['email'] ?? '';
            $newPassword = $data['new_password'] ?? '';
            if (!$token || !$email || !$newPassword) {
                sendResponse(["error" => "Email, token, and new_password required"], 400);
            }
            $stmt = $db->prepare("SELECT id FROM workers WHERE email = ?");
            $stmt->execute([$email]);
            $worker = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$worker) {
                sendResponse(["error" => "Worker not found"], 404);
            }
            $stmt = $db->prepare("SELECT id, token_hash, expires_at, used FROM password_resets WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1");
            $stmt->execute([$worker['id']]);
            $reset = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$reset || $reset['used']) {
                sendResponse(["error" => "Invalid or used token"], 400);
            }
            if (strtotime($reset['expires_at']) < time()) {
                sendResponse(["error" => "Token expired"], 400);
            }
            if (!password_verify($token, $reset['token_hash'])) {
                sendResponse(["error" => "Invalid token"], 400);
            }
            $stmt = $db->prepare("UPDATE workers SET password_hash = ? WHERE id = ?");
            $stmt->execute([password_hash($newPassword, PASSWORD_DEFAULT), $worker['id']]);
            $stmt = $db->prepare("UPDATE password_resets SET used = 1 WHERE id = ?");
            $stmt->execute([$reset['id']]);
            sendResponse(["message" => "Password updated"]);
        } else {
            sendResponse(["error" => "Invalid action"], 400);
        }
    } else {
        sendResponse(["error" => "Method not allowed"], 405);
    }
} catch (Exception $e) {
    sendResponse(["error" => $e->getMessage()], 500);
}
?>
