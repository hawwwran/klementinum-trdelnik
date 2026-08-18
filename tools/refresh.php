<?php
declare(strict_types=1);

/** CLI face of the tail update, for cron or a manual catch-up after downtime. */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("cli only\n");
}

require __DIR__ . '/../api/update.php';

$status = klem_refresh(['force' => in_array('--force', $argv, true)]);
echo json_encode($status, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION), "\n";
exit(empty($status['ok']) ? 1 : 0);
