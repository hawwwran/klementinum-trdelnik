<?php
declare(strict_types=1);

/**
 * Incremental tail update of data/*.i16 + data/meta.json from the CHMI recent
 * feed. Cheap enough to run on every page load (api/refresh.php calls it before
 * the app reads meta.json): the historical CSVs are never re-parsed, only the
 * feed months after meta.hist_end are re-checked, and each check is a
 * conditional GET that answers 304 when CHMI has published nothing new.
 *
 * Days up to meta.hist_end belong to the historical CSVs and are never touched;
 * only tools/prepare_data.py writes those. Everything after it is feed-owned, so
 * a late revision of a preliminary value lands on a later run.
 */

require __DIR__ . '/chmi.php';

const KLEM_SENTINEL = -32768;
const KLEM_SENTINEL_LE = "\x00\x80";
const KLEM_MAX_MONTHS = 30;      // bounds the work if the CSV base is far out of date
const KLEM_MIN_INTERVAL = 300;   // s between CHMI checks; the feed publishes once a day
const KLEM_SCAN_CHUNK = 16384;   // bytes per extremes-scan read (8192 values)

function klem_data_dir(): string
{
    return dirname(__DIR__) . '/data';
}

function klem_day(string $start, int $i): string
{
    return gmdate('Y-m-d', strtotime($start . ' UTC') + $i * 86400);
}

function klem_day_index(string $start, string $day): int
{
    return (int) round((strtotime($day . ' UTC') - strtotime($start . ' UTC')) / 86400);
}

function klem_read_json(string $path)
{
    if (!is_file($path)) {
        return null;
    }
    $raw = file_get_contents($path);
    if ($raw === false) {
        return null;
    }
    $val = json_decode($raw, true);
    return is_array($val) ? $val : null;
}

function klem_write_atomic(string $path, string $body): void
{
    $tmp = $path . '.tmp';
    $len = strlen($body);
    // A full disk or an exceeded quota makes file_put_contents return a SHORT
    // byte count, not false. Comparing against strlen is what stops a truncated
    // meta.json being renamed over a good one, which would leave the app with a
    // permanently unparseable file and a blank page.
    $written = file_put_contents($tmp, $body);
    if ($written !== $len) {
        @unlink($tmp);
        throw new RuntimeException(sprintf(
            'short write to %s (%s of %d bytes); is data/ writable and the disk not full?',
            basename($tmp),
            var_export($written, true),
            $len
        ));
    }
    if (!rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException('cannot replace ' . basename($path));
    }
}

/** fwrite that treats a short write as the failure it is. */
function klem_fwrite_all($fh, string $bytes, string $what): void
{
    $written = fwrite($fh, $bytes);
    if ($written !== strlen($bytes)) {
        throw new RuntimeException(sprintf(
            'short write to %s (%s of %d bytes); is the disk full?',
            $what,
            var_export($written, true),
            strlen($bytes)
        ));
    }
}

function klem_write_json(string $path, array $value): void
{
    $flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION;
    klem_write_atomic($path, json_encode($value, $flags) . "\n");
}

function klem_i16_decode(string $bytes): int
{
    $u = unpack('v', $bytes)[1];
    return $u > 32767 ? $u - 65536 : $u;
}

function klem_i16_encode(int $v): string
{
    return pack('v', $v < 0 ? $v + 65536 : $v);
}

/** Values that differ from what the file already holds, as [index => int16]. */
function klem_diff_days(string $path, string $start, array $days, int $nOld): array
{
    $diff = [];
    $fh = fopen($path, 'rb');
    if (!$fh) {
        throw new RuntimeException('cannot read ' . basename($path));
    }
    foreach ($days as $day => $value) {
        $i = klem_day_index($start, $day);
        if ($i < 0) {
            continue;
        }
        $iv = (int) round($value * 10);
        if ($i >= $nOld) {
            $diff[$i] = $iv;                     // appended day, nothing to compare
            continue;
        }
        fseek($fh, $i * 2);
        $bytes = fread($fh, 2);
        if ($bytes === false || strlen($bytes) !== 2 || klem_i16_decode($bytes) !== $iv) {
            $diff[$i] = $iv;
        }
    }
    fclose($fh);
    return $diff;
}

/**
 * Copies the element file, applies $diff, grows the grid to $nNew days, and
 * renames it into place. Returns the scan of the written file.
 */
function klem_apply(string $path, string $start, array $diff, int $nOld, int $nNew): array
{
    $tmp = $path . '.tmp';
    if (!copy($path, $tmp)) {
        throw new RuntimeException('cannot copy ' . basename($path) . ' (is data/ writable?)');
    }
    try {
        $fh = fopen($tmp, 'r+b');
        if (!$fh) {
            throw new RuntimeException('cannot open ' . basename($tmp));
        }
        try {
            if ($nNew > $nOld) {
                fseek($fh, $nOld * 2);
                klem_fwrite_all($fh, str_repeat(KLEM_SENTINEL_LE, $nNew - $nOld), basename($tmp));
            }
            foreach ($diff as $i => $iv) {
                fseek($fh, $i * 2);
                klem_fwrite_all($fh, klem_i16_encode($iv), basename($tmp));
            }
            if (!fflush($fh)) {
                throw new RuntimeException('cannot flush ' . basename($tmp));
            }
        } finally {
            fclose($fh);
        }
        // The per-write checks above cannot see a write that landed short in the
        // OS buffer, so the finished file is measured before it replaces a good one.
        clearstatcache(true, $tmp);
        $size = filesize($tmp);
        if ($size !== $nNew * 2) {
            throw new RuntimeException(sprintf(
                '%s is %s bytes, expected %d; is the disk full?',
                basename($tmp),
                var_export($size, true),
                $nNew * 2
            ));
        }
        $scan = klem_scan($tmp, $start);
        if (!rename($tmp, $path)) {
            throw new RuntimeException('cannot replace ' . basename($path));
        }
    } catch (Throwable $e) {
        @unlink($tmp);
        throw $e;
    }
    return $scan;
}

/** Missing count + extremes with their dates, read in chunks so a 92 k-day
 *  element never becomes a 92 k-entry PHP array. */
function klem_scan(string $path, string $start): array
{
    $fh = fopen($path, 'rb');
    if (!$fh) {
        throw new RuntimeException('cannot read ' . basename($path));
    }
    $i = 0;
    $missing = 0;
    $tmin = null;
    $tmax = null;
    $tminI = 0;
    $tmaxI = 0;
    while (!feof($fh)) {
        $chunk = fread($fh, KLEM_SCAN_CHUNK);
        if ($chunk === false || $chunk === '') {
            break;
        }
        // klem_i16_decode inlined on purpose: this runs ~92k times per element
        // per refresh, and a PHP function call per value costs more than the
        // whole rest of the scan. Keep the two sign fixes in step.
        foreach (unpack('v*', $chunk) as $u) {
            $v = $u > 32767 ? $u - 65536 : $u;
            if ($v !== KLEM_SENTINEL) {
                if ($tmin === null || $v < $tmin) { $tmin = $v; $tminI = $i; }
                if ($tmax === null || $v > $tmax) { $tmax = $v; $tmaxI = $i; }
            } else {
                $missing++;
            }
            $i++;
        }
    }
    fclose($fh);
    if ($tmin === null) {
        throw new RuntimeException('no values in ' . basename($path));
    }
    return [
        'missing' => $missing,
        'tmin' => round($tmin / 10, 1),
        'tmin_date' => klem_day($start, $tminI),
        'tmax' => round($tmax / 10, 1),
        'tmax_date' => klem_day($start, $tmaxI),
    ];
}

/**
 * $opts: force (skip the throttle, CLI only), min_interval, months_cap.
 * Never throws for an ordinary "cannot do it right now" — those come back as
 * ok=false with a reason, so the page can just draw the data already on disk.
 */
function klem_refresh(array $opts = []): array
{
    $dir = klem_data_dir();
    $metaPath = $dir . '/meta.json';
    $statePath = $dir . '/recent-state.json';
    $force = !empty($opts['force']);
    $minInterval = (int) ($opts['min_interval'] ?? KLEM_MIN_INTERVAL);

    $meta = klem_read_json($metaPath);
    if (!$meta) {
        return ['ok' => false, 'updated' => false, 'reason' => 'no data/meta.json — run tools/prepare_data.py'];
    }

    // Non-blocking: reloads arrive in bursts, and a queue of workers all waiting
    // to rewrite the same files is worse than telling the page "already running".
    $lock = fopen($dir . '/refresh.lock', 'c');
    if (!$lock) {
        return ['ok' => false, 'updated' => false, 'reason' => 'data/ is not writable', 'end' => $meta['end']];
    }
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        fclose($lock);
        return ['ok' => true, 'updated' => false, 'reason' => 'refresh already running', 'end' => $meta['end']];
    }

    try {
        $state = klem_read_json($statePath) ?: [];
        $now = time();
        $checked = $state['checked'] ?? null;
        if (!$force && $checked !== null) {
            $age = $now - (int) strtotime($checked);
            if ($age >= 0 && $age < $minInterval) {
                return ['ok' => true, 'updated' => false, 'reason' => 'checked recently',
                        'end' => $meta['end'], 'checked' => $checked];
            }
        }

        $start = $meta['start'];
        $end = $meta['end'];
        $histEnd = $meta['hist_end'] ?? $meta['end'];
        $nOld = (int) $meta['days'];

        $months = chmi_months($histEnd, gmdate('Y-m-d', $now));
        $cap = (int) ($opts['months_cap'] ?? KLEM_MAX_MONTHS);
        if (count($months) > $cap) {
            $months = array_slice($months, -$cap);
        }

        // Stamp the throttle BEFORE going outbound, not after. If CHMI is down,
        // chmi_fetch_months throws and every later line is skipped: leaving
        // 'checked' stale means the guard above never fires again, and each page
        // hit re-issues the whole batch of 15 s requests, holding one PHP worker
        // apiece until the pool is gone. A process killed by max_execution_time
        // would not reach a catch block either, so the write goes here.
        $state['checked'] = gmdate('c', $now);
        klem_write_json($statePath, $state);

        $fetched = chmi_fetch_months($months, $state['months'] ?? []);

        $values = ['tma' => [], 'tavg' => [], 'tmi' => []];
        $monthsNew = 0;
        $cache = $state['months'] ?? [];
        foreach ($fetched as $key => $got) {
            if ($got['status'] === 200) {
                chmi_parse($got['payload'], $values);
                $cache[$key] = ['url' => $got['url'], 'etag' => $got['etag']];
                $monthsNew++;
            } elseif ($got['status'] === 304) {
                $cache[$key] = ['url' => $got['url'], 'etag' => $got['etag']];
            }
        }
        $state['months'] = $cache;

        // Feed-owned window only; the historical CSVs win up to hist_end, and
        // nothing beyond tomorrow is accepted at all. $feedEnd sizes every .i16
        // file, so one typo'd DT in the payload ('2062-08-05') would append ~13k
        // sentinel days to each element and write that length into meta.end, with
        // no way back short of a full rebuild. A day of slack covers the feed
        // running on a clock ahead of ours.
        $maxDay = gmdate('Y-m-d', $now + 86400);
        $patch = [];
        $feedEnd = $end;
        $rejected = 0;
        foreach ($values as $key => $days) {
            $patch[$key] = [];
            foreach ($days as $day => $value) {
                if (strcmp($day, $maxDay) > 0) {
                    $rejected++;
                    continue;
                }
                if (strcmp($day, $histEnd) > 0) {
                    $patch[$key][$day] = $value;
                    if (strcmp($day, $feedEnd) > 0) {
                        $feedEnd = $day;
                    }
                }
            }
        }
        if ($rejected > 0) {
            error_log(sprintf('klem_refresh: dropped %d feed day(s) dated after %s', $rejected, $maxDay));
        }
        $newEnd = strcmp($feedEnd, $end) > 0 ? $feedEnd : $end;
        $nNew = klem_day_index($start, $newEnd) + 1;

        if ($monthsNew === 0) {
            klem_write_json($statePath, $state);
            return ['ok' => true, 'updated' => false, 'reason' => 'no new data',
                    'end' => $end, 'checked' => $state['checked']];
        }

        // Merge is decided before anything is written: a re-published month
        // usually carries the values we already have, and rewriting identical
        // binaries would churn the files (and the browser cache) for nothing.
        $diffs = [];
        $changed = 0;
        foreach ($meta['elements'] as $key => $info) {
            $path = $dir . '/' . basename($info['file']);
            $diffs[$key] = klem_diff_days($path, $start, $patch[$key] ?? [], $nOld);
            $changed += count($diffs[$key]);
        }
        if ($changed === 0 && $nNew === $nOld) {
            klem_write_json($statePath, $state);
            return ['ok' => true, 'updated' => false, 'reason' => 'feed matches local data',
                    'end' => $end, 'months_fetched' => $monthsNew, 'checked' => $state['checked']];
        }

        // Binaries first, meta.json last: a fetch that lands mid-update then sees
        // an .i16 that is longer than meta.days (harmless, the tail is ignored)
        // rather than a meta.json promising days the binary does not have.
        $elements = [];
        $gMin = null;
        $gMax = null;
        foreach ($meta['elements'] as $key => $info) {
            $scan = klem_apply($dir . '/' . basename($info['file']), $start, $diffs[$key], $nOld, $nNew);
            $elements[$key] = ['label' => $info['label'], 'file' => $info['file']] + $scan;
            $gMin = $gMin === null ? $scan['tmin'] : min($gMin, $scan['tmin']);
            $gMax = $gMax === null ? $scan['tmax'] : max($gMax, $scan['tmax']);
        }
        $meta['end'] = $newEnd;
        $meta['days'] = $nNew;
        $meta['tmin'] = $gMin;
        $meta['tmax'] = $gMax;
        $meta['elements'] = $elements;
        klem_write_json($metaPath, $meta);
        $state['updated_at'] = $state['checked'];
        klem_write_json($statePath, $state);

        return ['ok' => true, 'updated' => true, 'end' => $newEnd,
                'days_added' => $nNew - $nOld, 'values_changed' => $changed,
                'months_fetched' => $monthsNew, 'checked' => $state['checked']];
    } catch (RuntimeException $e) {
        return ['ok' => false, 'updated' => false, 'reason' => $e->getMessage(), 'end' => $meta['end']];
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}
