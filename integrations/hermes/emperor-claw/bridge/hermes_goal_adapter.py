"""Native Hermes goal engine adapter (D18). Runs inside Hermes' venv, one action per process.

Invocation (emperor_bridge/goals.py): ``$HERMES_PYTHON hermes_goal_adapter.py`` with
``PYTHONPATH=<checkout>``, ``cwd=<checkout>``, ``HERMES_HOME=<profile home>`` and the JSON payload
on stdin (or ``--payload-file <path>``). Prints exactly one JSON object as the LAST stdout line.

Payload: ``{"action": "start|status|pause|resume|clear|evaluate", "sessionId": <Hermes logical
session id>, "previousSession"?: <id before a generation change>, "objective"?, "maxTurns"?,
"response"?}``.

Why `evaluate` used to fail (S-13): the goal judge imports ``hermes_bootstrap``, whose
``venv_sync.prepare_launch`` re-execs any interpreter that is not Hermes' "store python" into that
interpreter (``os.execv`` with a ``runpy`` wrapper). The re-exec'd process has already lost the
payload (stdin was consumed: ``JSONDecodeError``) and runs without the venv's site-packages
(``No module named 'ruamel'``). ``HERMES_DISABLE_LAZY_INSTALLS=1`` turns that launch-time
update/relaunch step off; the bridge never wants it from a helper process anyway.
"""
import json
import os
import sys

os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"  # before any Hermes import (see module docstring)


def _read_payload(argv):
    if len(argv) >= 2 and argv[0] == "--payload-file":
        with open(argv[1], encoding="utf-8") as handle:
            return json.load(handle)
    raw = sys.stdin.read()
    return json.loads(raw)


def dispatch(payload):
    from hermes_cli.goals import (GoalManager, gather_background_processes, load_goal, migrate_goal_to_session,
                                  parse_contract)
    session = payload['sessionId']
    if payload.get('previousSession') and payload['previousSession'] != session:
        if not migrate_goal_to_session(payload['previousSession'], session, reason='Emperor session generation'):
            parent, child = load_goal(payload['previousSession']), load_goal(session)
            if parent and (not child or parent.created_at != child.created_at or parent.goal != child.goal):
                raise RuntimeError('Could not migrate persistent objective')
    manager = GoalManager(session, default_max_turns=payload.get('maxTurns', 20))
    action = payload['action']
    decision = {}
    if action == 'start':
        objective, contract = parse_contract(payload['objective'])
        manager.set(objective, max_turns=payload.get('maxTurns', 20), contract=contract)
    elif action == 'pause':
        manager.pause()
    elif action == 'resume':
        manager.resume()
    elif action == 'clear':
        manager.clear()
    elif action == 'evaluate':
        decision = manager.evaluate_after_turn(payload['response'],
                                               background_processes=gather_background_processes(owner_task_id=session))
    elif action != 'status':
        raise ValueError('Unsupported objective action')
    state = manager.state
    if state is not None and load_goal(session) is None:
        raise RuntimeError("Hermes objective state was not persisted")
    return {'status': state.status if state else 'cleared', 'objective': state.goal if state else '',
            'turnsUsed': state.turns_used if state else 0, 'maxTurns': state.max_turns if state else 0,
            'message': decision.get('message') or manager.status_line(),
            'shouldContinue': bool(decision.get('should_continue')),
            'prompt': decision.get('continuation_prompt') or manager.next_continuation_prompt() or '',
            'contract': manager.render_contract()[:6000] if manager.has_contract() else '',
            'waiting': manager.is_waiting() if manager.is_active() else False,
            'verdict': decision.get('verdict') or '',
            'sessionId': session}


def main(argv):
    try:
        payload = _read_payload(argv)
        result = dispatch(payload)
    except Exception as exc:
        print(json.dumps({'status': 'unavailable',
                          'message': f'Native Hermes objectives unavailable ({type(exc).__name__}: {str(exc)[:300]}). '
                                     'Update the runtime or check its goal configuration.'}))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
