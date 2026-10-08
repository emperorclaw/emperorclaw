"""Bounded, durable scheduling around Hermes' native goal decisions."""
import json
import os
from pathlib import Path
import subprocess
import uuid


def native_goal(payload):
    root = Path(os.environ.get('HERMES_INSTALL_DIR', str(Path.home() / '.hermes/hermes-agent')))
    helper = str(Path(__file__).with_name('hermes_goal_adapter.py'))
    configured = os.environ.get('EMPEROR_HERMES_GOAL_PYTHON')
    runner = root / 'scripts/run-in-hermes-env'
    if configured:
        command = [configured, helper]
    elif runner.is_file():
        command = ['bash', str(runner), 'python3', helper]
    else:
        python = next((p for p in [root/'venv/bin/python', root/'.venv/bin/python'] if p.is_file()), None)
        if not python:
            raise RuntimeError('Update the Hermes runtime to enable persistent objectives')
        command = [str(python), helper]
    result = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True, timeout=90, cwd=root)
    # Native bootstrap may log before its final JSON response.
    try:
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError('Native Hermes goal adapter failed; check runtime configuration') from None
    if result.returncode or data.get('status') == 'unavailable':
        raise RuntimeError(data.get('message') or 'Native objective unavailable')
    return data


def process_commands(bridge, state, *, active=False):
    try:
        payload = bridge.api('GET', '/agents/goals', query={'agentId':bridge.AGENT_ID})
        state['goalTransportReady'] = True
    except Exception:
        state['goalTransportReady'] = False
        return False  # Older servers keep their ordinary messaging behavior.
    interrupted = False
    for command in payload.get('commands', []):
        request = command.get('metadataJson', {}).get('runtimeGoalRequest', {})
        action = request.get('action')
        current = state.get('objective')
        if current and command['id'] == current.get('commandId'):
            try:
                publish(bridge, current)
            except Exception as exc:
                bridge.log(f'Goal acknowledgment pending: {exc}')
            interrupted = interrupted or (active and current.get('status') in ('paused','cleared'))
            continue
        if active and action in ('start', 'resume'):
            result = {**(public_state(current) if current else {'status':'rejected'}), 'message':'Wait for current work to finish before starting or resuming an objective.'}
            try:
                bridge.api('POST','/agents/goals',query={'agentId':bridge.AGENT_ID},body={'commandId':command['id'],'goal':result})
            except Exception as exc:
                bridge.log(f'Goal acknowledgment pending: {exc}')
            continue
        try:
            if action == 'start' and current and current.get('status') == 'active':
                raise RuntimeError('Pause or clear the current objective before starting another')
            if action != 'start' and not current:
                raise RuntimeError('No persistent objective is set')
            if action == 'start':
                session = state.get('sessions', {}).get(f'{bridge.AGENT_NAME}:{command["threadId"]}') or 'emperor-goal-' + str(uuid.uuid4())
            else:
                session = current['sessionId']
            result = native_goal({'action':action,'sessionId':session,'objective':request.get('objective',''),'maxTurns':request.get('maxTurns',20)})
            goal = {**result, 'commandId':command['id'], 'sourceMessageId':current.get('sourceMessageId', current['commandId']) if current and action != 'start' else command['id'], 'threadId':current['threadId'] if current and action != 'start' else command['threadId'], 'senderId':current.get('senderId') if current and action != 'start' else command.get('senderId'), 'firstTurn':action == 'start'}
            if action == 'resume':
                goal['prompt'] = result.get('prompt') or result.get('objective','')
            state['objective'] = goal
            result = goal
            bridge.save_state(state)  # durable before acknowledging, including pause/clear
            interrupted = interrupted or (active and action in ('pause','clear'))
        except Exception as exc:
            if current and action in ('pause','clear'):
                current.update(status='paused' if action == 'pause' else 'cleared', shouldContinue=False, message=f'Objective {action} applied; native state unavailable: {exc}'[:1000], commandId=command['id'])
                bridge.save_state(state)
                interrupted = interrupted or active
            result = {**(public_state(current) if current else {'status':'unavailable'}), 'message':str(exc)[:1000]}
        try:
            bridge.api('POST','/agents/goals',query={'agentId':bridge.AGENT_ID},body={'commandId':command['id'],'goal':public_state(result)})
        except Exception as exc:
            bridge.log(f'Goal acknowledgment pending: {exc}')
    return interrupted


def public_state(goal):
    return {**{key:goal.get(key) for key in ('status','objective','contract','turnsUsed','maxTurns','message','waiting')}, 'ownerId':goal.get('senderId') or goal.get('ownerId')}


def publish(bridge, goal):
    bridge.api('POST','/agents/goals',query={'agentId':bridge.AGENT_ID},body={'commandId':goal['commandId'],'goal':public_state(goal)})


def pause_all(bridge, state, reason="Objective paused by Stop or Replace."):
    goal = state.get('objective')
    if goal and goal.get('status') == 'active':
        # Local pause persists even if a broken/old native runtime cannot load its state.
        goal.update(status='paused', message=reason, shouldContinue=False)
        bridge.save_state(state)
        try:
            native_goal({'action':'pause','sessionId':goal['sessionId']})
        except Exception as exc:
            bridge.log(f'Native goal pause: {exc}')
        try:
            publish(bridge, goal)
        except Exception as exc:
            bridge.log(f"Goal pause status pending: {exc}")


def record_external_turn(bridge, message, reply, state):
    goal = state.get("objective")
    if not goal or goal.get("status") != "active" or goal["threadId"] != message.get("threadId"):
        return
    if not bridge.check_budget():
        pause_all(bridge, state, 'Objective paused: agent or company budget is unavailable.')
        return
    try:
        session = state.get("sessions", {}).get(f'{bridge.AGENT_NAME}:{goal["threadId"]}')
        if not session:
            raise RuntimeError("Missing persisted Hermes session")
        goal.update(native_goal({"action":"evaluate", "sessionId":session, "previousSession":goal["sessionId"], "response":reply}), firstTurn=False)
        bridge.save_state(state)
        publish(bridge, goal)
    except Exception as exc:
        goal.update(status="paused", message=f"Objective paused: {exc}"[:1000])
        bridge.save_state(state)


def run_next(bridge, state):
    goal = state.get('objective')
    if not state.get('goalTransportReady') or not goal or goal.get('status') != 'active':
        return
    if not bridge.check_budget():
        pause_all(bridge, state, 'Objective paused: agent or company budget is unavailable.')
        return
    message = None
    try:
        # Refresh persisted native state: parked objectives do not spend another turn.
        actual_session = state.get('sessions', {}).get(f'{bridge.AGENT_NAME}:{goal["threadId"]}') if goal.get('pendingEvaluation') or not goal.get('firstTurn') else None
        status = native_goal({'action':'status','sessionId':actual_session or goal['sessionId'],'previousSession':goal['sessionId']})
        goal['sessionId'] = status.get('sessionId') or goal['sessionId']
        if status.get('status') != 'active':
            goal.update(status); bridge.save_state(state); publish(bridge, goal); return
        if status.get('waiting'):
            goal.update(status); bridge.save_state(state); publish(bridge, goal); return
        if goal.get('pendingEvaluation'):
            session = state.get('sessions', {}).get(f'{bridge.AGENT_NAME}:{goal["threadId"]}')
            result = native_goal({'action':'evaluate','sessionId':session,'previousSession':goal['sessionId'],'response':goal['pendingEvaluation']})
            goal.update(result, firstTurn=False)
            goal.pop('pendingEvaluation', None)
            bridge.save_state(state); publish(bridge, goal); return
        text = goal['objective'] if goal.get('firstTurn') else goal.get('prompt') or status.get('prompt')
        if not text:
            raise RuntimeError('Native objective has no continuation prompt')
        message = {'id':goal.get('sourceMessageId', goal['commandId']),'threadId':goal['threadId'],'threadType':'direct','senderType':'human','senderId':goal.get('senderId'),'text':text}
        bridge.send_heartbeat(1)
        reply = bridge.run_hermes(message, state)
        goal['pendingEvaluation'] = reply[:24000]
        bridge.save_state(state)
        bridge.report_token_usage(len(text), len(reply))
        reply_id = bridge.send_reply(message, reply)
        reasoning = getattr(bridge, '_last_turn_reasoning', None)
        if reply_id and reasoning:
            try:
                bridge.post_reasoning_history(reply_id, reasoning)
            except Exception as exc:
                bridge.log(f'Goal reasoning history not stored: {exc}')
        session = state.get('sessions', {}).get(f'{bridge.AGENT_NAME}:{goal["threadId"]}')
        if not session:
            raise RuntimeError('Hermes did not return a persisted session; objective paused')
        # A human may have paused during model/tool execution. Never undo that pause.
        process_commands(bridge, state)
        if state['objective'].get('status') != 'active':
            return
        if not bridge.check_budget():
            pause_all(bridge, state, 'Objective paused: agent or company budget is unavailable.')
            return
        result = native_goal({'action':'evaluate','sessionId':session,'previousSession':goal['sessionId'],'response':reply})
        goal.update(result, firstTurn=False)
        goal.pop('pendingEvaluation', None)
        state['objective'] = goal
        bridge.save_state(state)
        publish(bridge, goal)
    except bridge.TurnInterrupted:
        return
    except Exception as exc:
        goal.update(status='paused', message=f'Objective paused: {exc}'[:1000], shouldContinue=False)
        state['objective'] = goal
        bridge.save_state(state)
        publish(bridge, goal)
    finally:
        if message is not None:
            try:
                bridge.update_chat_status(message, typing=False)
            except Exception as exc:
                bridge.log(f"Goal typing status pending: {exc}")
        bridge.send_heartbeat(0)
