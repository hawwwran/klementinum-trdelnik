<?php
declare(strict_types=1);

/**
 * Dev router for `php -S localhost:8123 tools/router.php`.
 *
 * Mirrors the PHP hosting setup (api/*.php runs) and serves static files with
 * Cache-Control: no-cache, so a reload after an edit cannot mix stale and fresh
 * ES modules. The files are read here rather than handed back to the built-in
 * server, because headers set in a router are dropped when it returns false.
 */

const MIME = [
    'html' => 'text/html; charset=utf-8',
    'css' => 'text/css; charset=utf-8',
    'js' => 'text/javascript; charset=utf-8',
    'json' => 'application/json',
    'svg' => 'image/svg+xml',
    'png' => 'image/png',
    'ico' => 'image/x-icon',
    'i16' => 'application/octet-stream',
];

$root = dirname(__DIR__);
$path = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = realpath($root . $path);
// Directory index, the way DirectoryIndex does it on the host.
if ($path === '' || substr($path, -1) === '/' || ($file !== false && is_dir($file))) {
    $file = realpath(rtrim($root . $path, '/') . '/index.html');
}

if ($file === false || strpos($file, $root . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo "404 $path\n";
    return true;
}
if (substr($file, -4) === '.php') {
    return false;                                  // the built-in server runs it
}

$ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
header('Cache-Control: no-cache');
header('Content-Type: ' . (MIME[$ext] ?? 'application/octet-stream'));
header('Content-Length: ' . filesize($file));
readfile($file);
return true;
