<?php
/**
 * WongMing Discord Bridge for Discuz! X3.4
 *
 * Install this file as:
 *   <Discuz root>/api/wm_discord_bridge.php
 *
 * IMPORTANT:
 * 1) Replace BRIDGE_SECRET with a long random secret.
 * 2) Put the same secret in Render as DZ_BRIDGE_SECRET.
 * 3) Put the full URL in Render as DZ_BRIDGE_URL.
 */

define('IN_DISCUZ', true);
define('DISCUZ_ROOT', dirname(__DIR__) . DIRECTORY_SEPARATOR);
define('CURSCRIPT', 'api');

require DISCUZ_ROOT . 'source/class/class_core.php';
require_once DISCUZ_ROOT . 'source/function/function_member.php';

const BRIDGE_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_SECRET';
const BRIDGE_USERNAME = 'REPLACE_WITH_DISCUZ_SERVICE_USERNAME';
const BRIDGE_FID = 53;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function bridge_json($code, $body) {
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function bridge_auth() {
    $provided = isset($_SERVER['HTTP_X_WM_BRIDGE_KEY']) ? $_SERVER['HTTP_X_WM_BRIDGE_KEY'] : '';
    if (!$provided || !hash_equals(BRIDGE_SECRET, $provided)) {
        bridge_json(403, array('ok' => false, 'error' => 'invalid-bridge-key'));
    }
}

function bridge_input() {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        $raw = '';
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        bridge_json(400, array('ok' => false, 'error' => 'invalid-json'));
    }
    return $data;
}

function bridge_login_service_account() {
    global $_G;

    $member = C::t('common_member')->fetch_by_username(BRIDGE_USERNAME);
    if (!$member || empty($member['uid'])) {
        bridge_json(500, array('ok' => false, 'error' => 'service-account-not-found'));
    }

    // Establish the normal Discuz logged-in user context.
    setloginstatus($member, 3600);

    if (empty($_G['uid'])) {
        bridge_json(500, array('ok' => false, 'error' => 'service-account-login-failed'));
    }

    return $member;
}

function bridge_model_error_handler($message) {
    if (is_array($message)) {
        $message = json_encode($message, JSON_UNESCAPED_UNICODE);
    }
    throw new RuntimeException((string)$message);
}

function bridge_thread_url($tid) {
    global $_G;
    return rtrim($_G['siteurl'], '/') . '/forum.php?mod=viewthread&tid=' . intval($tid);
}

bridge_auth();

$input = bridge_input();
$action = isset($input['action']) ? (string)$input['action'] : '';
$fid = isset($input['fid']) ? intval($input['fid']) : BRIDGE_FID;

$discuz = C::app();
$discuz->init();
$member = bridge_login_service_account();

try {
    if ($action === 'ping') {
        include_once libfile('function/forum');
        loadforum($fid);

        bridge_json(200, array(
            'ok' => true,
            'action' => 'ping',
            'uid' => intval($member['uid']),
            'username' => $member['username'],
            'fid' => intval($_G['forum']['fid']),
            'allowpost' => intval($_G['forum']['allowpost']),
            'allowreply' => intval($_G['forum']['allowreply'])
        ));
    }

    if ($action === 'newthread') {
        if ($fid !== BRIDGE_FID) {
            bridge_json(403, array('ok' => false, 'error' => 'forum-not-allowed'));
        }

        $subject = trim((string)($input['subject'] ?? 'Discord 同步'));
        $message = (string)($input['message'] ?? '');

        include_once libfile('function/forum');
        loadforum($fid);

        if (empty($_G['forum']['fid'])) {
            bridge_json(404, array('ok' => false, 'error' => 'forum-not-found'));
        }
        if (empty($_G['forum']['allowpost'])) {
            bridge_json(403, array('ok' => false, 'error' => 'forum-newthread-not-allowed'));
        }

        $model = C::m('forum_thread', $fid);
        $model->showmessage = 'bridge_model_error_handler';

        $params = array(
            'member' => $_G['member'],
            'group' => $_G['group'],
            'forum' => $_G['forum'],
            'subject' => $subject,
            'message' => $message,
            'typeid' => 0,
            'sortid' => 0,
            'special' => 0,
            'publishdate' => TIMESTAMP,
            'save' => 0,
            'sticktopic' => 0,
            'digest' => 0,
            'readperm' => 0,
            'isanonymous' => 0,
            'price' => 0,
            'allownoticeauthor' => 0,
            'tags' => '',
            'bbcodeoff' => 0,
            'smileyoff' => 0,
            'parseurloff' => 0,
            'usesig' => 0,
            'htmlon' => 0,
            'closed' => 0,
            'replycredit' => 0,
            'tstatus' => 0,
            'pstatus' => 0,
            'clientip' => $_G['clientip'],
            'remoteport' => $_G['remoteport'],
            'extramessage' => '',
            'geoloc' => ''
        );

        $model->newthread($params);

        bridge_json(200, array(
            'ok' => true,
            'action' => 'newthread',
            'tid' => intval($model->tid),
            'pid' => intval($model->pid),
            'url' => bridge_thread_url($model->tid)
        ));
    }

    if ($action === 'newreply') {
        $tid = isset($input['tid']) ? intval($input['tid']) : 0;
        $message = (string)($input['message'] ?? '');

        if ($tid <= 0) {
            bridge_json(400, array('ok' => false, 'error' => 'missing-tid'));
        }

        include_once libfile('function/forum');
        loadforum(null, $tid);

        if (empty($_G['thread']['tid'])) {
            bridge_json(404, array('ok' => false, 'error' => 'thread-not-found'));
        }
        if (empty($_G['forum']['allowreply'])) {
            bridge_json(403, array('ok' => false, 'error' => 'forum-reply-not-allowed'));
        }

        $model = C::m('forum_post', $tid);
        $model->showmessage = 'bridge_model_error_handler';

        $params = array(
            'member' => $_G['member'],
            'group' => $_G['group'],
            'forum' => $_G['forum'],
            'thread' => $_G['thread'],
            'subject' => '',
            'message' => $message,
            'special' => intval($_G['thread']['special']),
            'isanonymous' => 0,
            'usesig' => 0,
            'htmlon' => 0,
            'bbcodeoff' => 0,
            'smileyoff' => 0,
            'parseurloff' => 0,
            'pstatus' => 0,
            'clientip' => $_G['clientip'],
            'remoteport' => $_G['remoteport'],
            'extramessage' => '',
            'noticetrimstr' => '',
            'noticeauthor' => '',
            'from' => '',
            'sechash' => '',
            'geoloc' => '',
            'timestamp' => TIMESTAMP
        );

        $model->newreply($params);

        bridge_json(200, array(
            'ok' => true,
            'action' => 'newreply',
            'tid' => $tid,
            'pid' => intval($model->pid),
            'url' => bridge_thread_url($tid) . '&pid=' . intval($model->pid) . '#pid' . intval($model->pid)
        ));
    }

    if ($action === 'recent') {
        if ($fid !== BRIDGE_FID) {
            bridge_json(403, array('ok' => false, 'error' => 'forum-not-allowed'));
        }

        $since = isset($input['since']) ? intval($input['since']) : (TIMESTAMP - 60);
        $limit = isset($input['limit']) ? max(1, min(20, intval($input['limit']))) : 10;

        $threads = C::t('forum_thread')->fetch_all_by_fid_lastpost($fid, $since, 0);
        $threads = array_slice($threads, 0, $limit);

        $posts = array();
        foreach ($threads as $thread) {
            $tid = intval($thread['tid']);
            $threadPosts = C::t('forum_post')->fetch_all_by_tid(
                'tid:' . $tid,
                $tid,
                true,
                'ASC',
                0,
                20,
                null,
                0
            );

            foreach ($threadPosts as $post) {
                if (intval($post['dateline']) < $since) {
                    continue;
                }

                $posts[] = array(
                    'tid' => $tid,
                    'pid' => intval($post['pid']),
                    'authorid' => intval($post['authorid']),
                    'author' => (string)$post['author'],
                    'subject' => (string)$thread['subject'],
                    'message' => (string)$post['message'],
                    'dateline' => intval($post['dateline']),
                    'url' => bridge_thread_url($tid) . '&pid=' . intval($post['pid']) . '#pid' . intval($post['pid'])
                );
            }
        }

        usort($posts, function($a, $b) {
            return $a['dateline'] <=> $b['dateline'];
        });

        bridge_json(200, array(
            'ok' => true,
            'action' => 'recent',
            'posts' => $posts
        ));
    }

    bridge_json(400, array('ok' => false, 'error' => 'unknown-action'));

} catch (Throwable $e) {
    bridge_json(500, array(
        'ok' => false,
        'error' => $e->getMessage()
    ));
}
