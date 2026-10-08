import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'integrations/hermes/emperor-claw/bridge'))
import emperor_goals as goals

class GoalsTests(unittest.TestCase):
    def setUp(self):
        self.bridge=SimpleNamespace(AGENT_ID='agent',AGENT_NAME='Ada',api=Mock(return_value={'commands':[]}),save_state=Mock(),log=Mock(),check_budget=Mock(return_value=True),send_heartbeat=Mock(),run_hermes=Mock(return_value='Verified deliverable'),report_token_usage=Mock(),send_reply=Mock(),update_chat_status=Mock(),TurnInterrupted=type('TurnInterrupted',(Exception,),{}))
        self.goal={'status':'active','objective':'Fix tests','commandId':'command','threadId':'thread','sessionId':'session','firstTurn':True,'maxTurns':5}
        self.state={'goalTransportReady':True,'objective':self.goal,'sessions':{'Ada:thread':'session'}}
    def test_one_native_decision_per_turn_and_usage(self):
        with patch.object(goals,'native_goal',side_effect=[{'status':'active','waiting':False},{'status':'done','message':'Verified','sessionId':'session','turnsUsed':1,'maxTurns':5}]) as native:
            goals.run_next(self.bridge,self.state)
        self.assertEqual(self.state['objective']['status'],'done')
        self.assertEqual(native.call_args_list[-1].args[0]['action'],'evaluate')
        self.bridge.run_hermes.assert_called_once()
        self.bridge.report_token_usage.assert_called_once()
        self.bridge.update_chat_status.assert_called_with(self.bridge.run_hermes.call_args.args[0], typing=False)
    def test_native_wait_does_not_consume_model_turn(self):
        with patch.object(goals,'native_goal',return_value={'status':'active','waiting':True}):goals.run_next(self.bridge,self.state)
        self.bridge.run_hermes.assert_not_called()
    def test_budget_pause_is_durable(self):
        self.bridge.check_budget.return_value=False
        with patch.object(goals,'native_goal'):
            goals.run_next(self.bridge,self.state)
        self.assertEqual(self.goal['status'],'paused')
        self.bridge.run_hermes.assert_not_called()
        self.bridge.save_state.assert_called()
    def test_old_server_keeps_messaging_and_suspends_goal_dispatch(self):
        self.bridge.api.side_effect=RuntimeError('404')
        self.assertFalse(goals.process_commands(self.bridge,self.state))
        goals.run_next(self.bridge,self.state)
        self.bridge.run_hermes.assert_not_called()
    def test_native_failure_pauses_instead_of_retry_loop(self):
        with patch.object(goals,'native_goal',side_effect=RuntimeError('Judge unavailable')):goals.run_next(self.bridge,self.state)
        self.assertEqual(self.goal['status'],'paused')
    def test_pause_command_is_persisted_before_acknowledgment(self):
        command={'id':'pause','threadId':'thread','metadataJson':{'runtimeGoalRequest':{'action':'pause'}}}
        self.bridge.api.return_value={'commands':[command]}
        with patch.object(goals,'native_goal',return_value={'status':'paused','sessionId':'session','objective':'Fix tests'}):
            self.assertTrue(goals.process_commands(self.bridge,self.state,active=True))
        self.assertEqual(self.state['objective']['status'],'paused')
        self.bridge.save_state.assert_called_once()
    def test_stop_keeps_local_pause_when_native_adapter_fails(self):
        with patch.object(goals,'native_goal',side_effect=RuntimeError('Old image')):goals.pause_all(self.bridge,self.state)
        self.assertEqual(self.goal['status'],'paused')
    def test_start_during_model_turn_is_rejected(self):
        self.bridge.api.return_value={'commands':[{'id':'start','metadataJson':{'runtimeGoalRequest':{'action':'start','objective':'New task'}}}]}
        with patch.object(goals,'native_goal') as native:goals.process_commands(self.bridge,self.state,active=True)
        native.assert_not_called()
        self.assertEqual(self.goal['objective'],'Fix tests')
    def test_normal_followup_consumes_native_goal_budget(self):
        with patch.object(goals,'native_goal',return_value={'status':'paused','turnsUsed':5,'sessionId':'session'}):goals.record_external_turn(self.bridge,{'threadId':'thread'},'More work',self.state)
        self.assertEqual(self.goal['turnsUsed'],5)
    def test_native_pause_survives_crash_before_bridge_snapshot(self):
        with patch.object(goals,'native_goal',return_value={'status':'paused','sessionId':'session'}):goals.run_next(self.bridge,self.state)
        self.bridge.run_hermes.assert_not_called()
        self.assertEqual(self.goal['status'],'paused')
    def test_resume_preserves_original_conversation_and_reply_source(self):
        self.goal.update(status='paused',sourceMessageId='original',senderId='owner')
        self.bridge.api.return_value={'commands':[{'id':'resume','threadId':'another-private-thread','senderId':'other','metadataJson':{'runtimeGoalRequest':{'action':'resume'}}}]}
        with patch.object(goals,'native_goal',return_value={'status':'active','sessionId':'session','objective':'Fix tests'}):goals.process_commands(self.bridge,self.state)
        self.assertEqual(self.state['objective']['threadId'],'thread')
        self.assertEqual(self.state['objective']['sourceMessageId'],'original')
        self.assertEqual(self.state['objective']['senderId'],'owner')
    def test_pause_stops_active_turn_even_if_native_pause_and_ack_fail(self):
        command={'id':'pause','threadId':'thread','metadataJson':{'runtimeGoalRequest':{'action':'pause'}}}
        self.bridge.api.side_effect=[{'commands':[command]},RuntimeError('network')]
        with patch.object(goals,'native_goal',side_effect=RuntimeError('native unavailable')):
            self.assertTrue(goals.process_commands(self.bridge,self.state,active=True))
        self.assertEqual(self.goal['status'],'paused')
        self.bridge.save_state.assert_called()
    def test_replayed_resume_is_acknowledged_without_resetting_budget(self):
        self.bridge.api.return_value={'commands':[{'id':'command','metadataJson':{'runtimeGoalRequest':{'action':'resume'}}}]}
        with patch.object(goals,'native_goal') as native:goals.process_commands(self.bridge,self.state)
        native.assert_not_called()
    def test_restart_judges_saved_response_without_running_model_again(self):
        self.goal['pendingEvaluation']='Already finished turn'
        with patch.object(goals,'native_goal',side_effect=[{'status':'active'},{'status':'done','sessionId':'session'}]):goals.run_next(self.bridge,self.state)
        self.bridge.run_hermes.assert_not_called()
        self.assertEqual(self.goal['status'],'done')
        self.assertNotIn('pendingEvaluation',self.goal)
    def test_new_goal_reuses_its_actual_thread_session_not_another_goal_session(self):
        self.goal.update(status='done',sessionId='other-old-session')
        self.bridge.api.return_value={'commands':[{'id':'new','threadId':'thread','metadataJson':{'runtimeGoalRequest':{'action':'start','objective':'New objective'}}}]}
        with patch.object(goals,'native_goal',return_value={'status':'active','sessionId':'session','objective':'New objective'}) as native:goals.process_commands(self.bridge,self.state)
        self.assertEqual(native.call_args.args[0]['sessionId'],'session')
    def test_restart_reads_migrated_session_before_judging_saved_output(self):
        self.goal.update(sessionId='old',pendingEvaluation='Finished output')
        with patch.object(goals,'native_goal',return_value={'status':'done','sessionId':'session'}) as native:goals.run_next(self.bridge,self.state)
        self.assertEqual(native.call_args.args[0]['sessionId'],'session')
        self.assertEqual(native.call_args.args[0]['previousSession'],'old')
        self.bridge.run_hermes.assert_not_called()
        self.assertEqual(self.goal['status'],'done')
    def test_other_conversation_does_not_affect_objective(self):
        with patch.object(goals,'native_goal') as native:goals.record_external_turn(self.bridge,{'threadId':'other'},'Other work',self.state)
        native.assert_not_called()

if __name__=='__main__':unittest.main()
