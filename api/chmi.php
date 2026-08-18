<?php
declare(strict_types=1);

/**
 * CHMI "recent" daily feed for one station: fetch + parse.
 *
 * The feed publishes one ~36 KB JSON per month, past months under daily/MM/ and
 * the running month at daily/ root, so from day to day only ONE file changes.
 * Every file carries an ETag, which turns "anything new?" into a conditional
 * GET that answers 304 with no body.
 */

const CHMI_STATION = '0-203-0-11514';
const CHMI_BASE = 'https://opendata.chmi.cz/meteorology/climate/recent/data/daily';
const CHMI_KEYS = ['tma', 'tavg', 'tmi'];
const CHMI_CONNECT_TIMEOUT = 5;
const CHMI_TIMEOUT = 15;

function chmi_month_urls(int $y, int $m): array
{
    $name = sprintf('dly-%s-%d%02d.json', CHMI_STATION, $y, $m);
    return [sprintf('%s/%02d/%s', CHMI_BASE, $m, $name), CHMI_BASE . '/' . $name];
}

/** Inclusive year/month pairs from $first to $last, both 'YYYY-MM-DD'. */
function chmi_months(string $first, string $last): array
{
    [$y, $m] = [(int) substr($first, 0, 4), (int) substr($first, 5, 2)];
    [$ly, $lm] = [(int) substr($last, 0, 4), (int) substr($last, 5, 2)];
    $out = [];
    while ($y * 12 + $m <= $ly * 12 + $lm) {
        $out[] = [$y, $m];
        if ($m === 12) { $y++; $m = 1; } else { $m++; }
    }
    return $out;
}

/**
 * Runs $reqs (each ['url' =>, 'etag' =>]) and returns the same keys mapped to
 * ['status' =>, 'body' =>, 'etag' =>]. Parallel through curl_multi where curl
 * is available; hosts without it fall back to sequential stream requests.
 */
function chmi_http_batch(array $reqs): array
{
    if (extension_loaded('curl')) {
        return chmi_http_batch_curl($reqs);
    }
    if (!ini_get('allow_url_fopen')) {
        throw new RuntimeException('no outbound HTTP: curl extension missing and allow_url_fopen off');
    }
    $out = [];
    foreach ($reqs as $key => $req) {
        $out[$key] = chmi_http_stream($req);
    }
    return $out;
}

function chmi_http_batch_curl(array $reqs): array
{
    $multi = curl_multi_init();
    $handles = [];
    $etags = [];
    foreach ($reqs as $key => $req) {
        $ch = curl_init($req['url']);
        $etags[$key] = null;
        $headers = ['Accept: application/json'];
        if (!empty($req['etag'])) {
            $headers[] = 'If-None-Match: ' . $req['etag'];
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CONNECTTIMEOUT => CHMI_CONNECT_TIMEOUT,
            CURLOPT_TIMEOUT => CHMI_TIMEOUT,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT => 'klementinum-trdelnik/1.0',
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$etags, $key) {
                if (stripos($line, 'etag:') === 0) {
                    $etags[$key] = trim(substr($line, 5));
                }
                return strlen($line);
            },
        ]);
        curl_multi_add_handle($multi, $ch);
        $handles[$key] = $ch;
    }

    do {
        $status = curl_multi_exec($multi, $running);
        if ($running) {
            curl_multi_select($multi, 1.0);
        }
    } while ($running && $status === CURLM_OK);

    $out = [];
    $failed = null;
    foreach ($handles as $key => $ch) {
        $err = curl_error($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $out[$key] = [
            'status' => $code,
            'body' => (string) curl_multi_getcontent($ch),
            'etag' => $etags[$key],
        ];
        if ($err !== '' && $code === 0) {
            $failed = $err;
        }
        curl_multi_remove_handle($multi, $ch);
        curl_close($ch);
    }
    curl_multi_close($multi);
    if ($failed !== null) {
        throw new RuntimeException('feed unreachable: ' . $failed);
    }
    return $out;
}

function chmi_http_stream(array $req): array
{
    $headers = "Accept: application/json\r\nUser-Agent: klementinum-trdelnik/1.0\r\n";
    if (!empty($req['etag'])) {
        $headers .= 'If-None-Match: ' . $req['etag'] . "\r\n";
    }
    $ctx = stream_context_create(['http' => [
        'method' => 'GET',
        'header' => $headers,
        'timeout' => CHMI_TIMEOUT,
        'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($req['url'], false, $ctx);
    if ($body === false && !isset($http_response_header)) {
        throw new RuntimeException('feed unreachable: ' . $req['url']);
    }
    $code = 0;
    $etag = null;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
            $code = (int) $m[1];
        } elseif (stripos($line, 'etag:') === 0) {
            $etag = trim(substr($line, 5));
        }
    }
    return ['status' => $code, 'body' => (string) $body, 'etag' => $etag];
}

/**
 * One conditional fetch per month. $cache maps 'YYYYMM' to the ['url', 'etag']
 * that worked last time. Returns 'YYYYMM' => ['status', 'payload', 'url', 'etag'],
 * status 200 fetched / 304 unchanged / 404 not published.
 */
function chmi_fetch_months(array $months, array $cache): array
{
    $out = [];
    $pending = [];
    foreach ($months as [$y, $m]) {
        $key = sprintf('%d%02d', $y, $m);
        $urls = chmi_month_urls($y, $m);
        $prev = $cache[$key] ?? null;
        // Retry the URL that worked last time first, so its ETag stays usable:
        // a month moves from the daily/ root into daily/MM/ once it is over.
        if ($prev && isset($prev['url']) && in_array($prev['url'], $urls, true)) {
            $urls = array_values(array_unique(array_merge([$prev['url']], $urls)));
        }
        $out[$key] = ['status' => 404, 'payload' => null, 'url' => null, 'etag' => null];
        $pending[$key] = ['urls' => $urls, 'prev' => $prev];
    }

    // Two rounds at most: the alternate URL only matters when the first 404s.
    for ($round = 0; $round < 2; $round++) {
        $reqs = [];
        foreach ($pending as $key => $job) {
            if (!isset($job['urls'][$round])) {
                continue;
            }
            $url = $job['urls'][$round];
            $etag = ($job['prev'] && ($job['prev']['url'] ?? null) === $url) ? $job['prev']['etag'] : null;
            $reqs[$key] = ['url' => $url, 'etag' => $etag];
        }
        if (!$reqs) {
            break;
        }
        foreach (chmi_http_batch($reqs) as $key => $res) {
            $url = $reqs[$key]['url'];
            if ($res['status'] === 304) {
                $out[$key] = ['status' => 304, 'payload' => null, 'url' => $url, 'etag' => $reqs[$key]['etag']];
                unset($pending[$key]);
            } elseif ($res['status'] === 200) {
                $payload = json_decode($res['body'], true);
                if (!is_array($payload)) {
                    throw new RuntimeException("feed returned unparsable JSON for $key");
                }
                $out[$key] = ['status' => 200, 'payload' => $payload, 'url' => $url, 'etag' => $res['etag']];
                unset($pending[$key]);
            } elseif ($res['status'] !== 404) {
                throw new RuntimeException("feed HTTP {$res['status']} for $key");
            }
        }
    }
    return $out;
}

/**
 * Feed rows -> $out[element key]['YYYY-MM-DD'] = value. TMA/TMI as published,
 * daily mean from the T rows flagged AVG (the same selection prepare_data.py
 * makes from the historical CSVs).
 */
function chmi_parse(array $payload, array &$out): void
{
    $rows = $payload['data']['data']['values'] ?? [];
    foreach ($rows as $row) {
        if (count($row) < 5 || $row[4] === null) {
            continue;
        }
        [, $el, $vtype, $dt, $val] = $row;
        $day = substr($dt, 0, 10);
        if ($el === 'TMA') {
            $out['tma'][$day] = (float) $val;
        } elseif ($el === 'TMI') {
            $out['tmi'][$day] = (float) $val;
        } elseif ($el === 'T' && $vtype === 'AVG') {
            $out['tavg'][$day] = (float) $val;
        }
    }
}
