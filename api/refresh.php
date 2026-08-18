<?php
declare(strict_types=1);

/**
 * GET api/refresh.php — bring data/ up to date, answer with the status JSON.
 * The app calls this before it reads data/meta.json.
 */

require __DIR__ . '/update.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

// This endpoint is public, so it never honours a "force" parameter: forcing
// skips the throttle, and one outbound fetch per hit is a free amplifier.
// Use tools/refresh.php --force from the shell or cron instead.
try {
    $status = klem_refresh();
} catch (Throwable $e) {
    error_log('refresh failed: ' . $e);
    $status = ['ok' => false, 'updated' => false, 'reason' => get_class($e) . ': ' . $e->getMessage()];
}

echo json_encode($status, JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
