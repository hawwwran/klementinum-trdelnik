<?php
declare(strict_types=1);

/**
 * Host capability probe: run this once after uploading to a new host to see
 * whether the on-load refresh can work there. Not needed at runtime, and closed
 * to the web until DIAG_KEY below is set.
 */

require __DIR__ . '/chmi.php';

/*
 * Closed by default. Unauthenticated, this dumps the PHP version and SAPI, which
 * extensions are loaded, open_basedir, memory and execution limits, whether
 * data/ is writable, and it runs an outbound HTTPS request to CHMI on the
 * caller's behalf, bypassing the refresh throttle entirely: a free egress prober
 * and amplifier. "Delete it after you have used it" is exactly the manual step
 * that gets skipped, so the file refuses to answer instead.
 *
 * To use it over HTTP, set DIAG_KEY to a random string and request
 * api/diag.php?key=<that string>. Clear it again afterwards. From a shell it
 * runs unguarded: `php api/diag.php`.
 */
const DIAG_KEY = '';

if (PHP_SAPI !== 'cli'
    && (DIAG_KEY === '' || !hash_equals(DIAG_KEY, (string) ($_GET['key'] ?? '')))) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo "404\n";
    exit;
}

header('Content-Type: application/json');
header('Cache-Control: no-store');

$dir = dirname(__DIR__) . '/data';
$probe = ['url' => CHMI_BASE . '/' . sprintf('dly-%s-%s.json', CHMI_STATION, gmdate('Ym')), 'etag' => null];

$outbound = ['ok' => false, 'detail' => null];
try {
    $res = chmi_http_batch(['probe' => $probe])['probe'];
    $outbound = ['ok' => $res['status'] === 200, 'detail' => 'HTTP ' . $res['status'] . ', ' . strlen($res['body']) . ' bytes'];
} catch (Throwable $e) {
    $outbound = ['ok' => false, 'detail' => $e->getMessage()];
}

$meta = is_file($dir . '/meta.json') ? json_decode((string) file_get_contents($dir . '/meta.json'), true) : null;
$files = [];
foreach (['meta.json', 'tma.i16', 'tavg.i16', 'tmi.i16'] as $name) {
    $files[$name] = is_file($dir . '/' . $name) ? filesize($dir . '/' . $name) : null;
}

echo json_encode([
    'php' => PHP_VERSION,
    'sapi' => PHP_SAPI,
    'extensions' => ['curl' => extension_loaded('curl'), 'json' => extension_loaded('json'), 'openssl' => extension_loaded('openssl')],
    'allow_url_fopen' => (bool) ini_get('allow_url_fopen'),
    'limits' => [
        'max_execution_time' => ini_get('max_execution_time'),
        'memory_limit' => ini_get('memory_limit'),
        'open_basedir' => ini_get('open_basedir') ?: null,
    ],
    'data_dir_writable' => is_writable($dir),
    'files' => $files,
    'data_through' => $meta['end'] ?? null,
    'hist_end' => $meta['hist_end'] ?? null,
    'outbound_feed' => $outbound,
    'utc_now' => gmdate('c'),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
