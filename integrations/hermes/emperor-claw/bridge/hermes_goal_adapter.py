"""Native Hermes goal engine adapter. Run inside Hermes' dependency environment."""
import json
import sys


def dispatch(payload):
    from hermes_cli.goals import GoalManager, parse_contract, migrate_goal_to_session, gather_background_processes, load_goal
    session = payload['sessionId']
    if payload.get('previousSession') and payload['previousSession'] != session:
        if not migrate_goal_to_session(payload['previousSession'], session, reason='Emperor session rotation'):
            parent, child = load_goal(payload['previousSession']), load_goal(session)
            if not parent or not child or parent.created_at != child.created_at or parent.goal != child.goal:
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
        decision = manager.evaluate_after_turn(payload['response'], background_processes=gather_background_processes(owner_task_id=session))
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
            'sessionId': session}


if __name__ == '__main__':
    try:
        print(json.dumps(dispatch(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'status':'unavailable', 'message':f'Native Hermes objectives unavailable ({type(exc).__name__}). Update the runtime or check its goal configuration.'}))
        sys.exit(1)
