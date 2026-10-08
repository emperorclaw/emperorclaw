import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseGoalCommand} from '../../src/lib/agent-goal';
test('goals intercept native controls and preserve escaped objective text',()=>{
 assert.equal(parseGoalCommand('normal message'),null);
 assert.deepEqual(parseGoalCommand('/goal'),{action:'status',objective:''});
 assert.deepEqual(parseGoalCommand('/goal pause please'),{action:'pause',objective:''});
 assert.deepEqual(parseGoalCommand('/goal -- pause nightly jobs'),{action:'start',objective:'pause nightly jobs'});
 assert.deepEqual(parseGoalCommand('/goal Fix tests\nverify: suite passes'),{action:'start',objective:'Fix tests\nverify: suite passes'});
 assert.equal(parseGoalCommand('/goal gate add npm test')?.action,'unsupported');
});
