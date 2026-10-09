import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsSections,resolveSettingsTab} from '../../src/lib/settings-navigation';
test('settings deep links recover from unknown or unauthorized destinations',()=>{
 const member={isAdmin:false,instanceAdmin:false};
 assert.equal(resolveSettingsTab('profile',member),'profile');
 assert.equal(resolveSettingsTab('unexpected',member),'connections');
 assert.equal(resolveSettingsTab('members',member),'connections');
 assert.equal(resolveSettingsTab('instance',{isAdmin:true,instanceAdmin:false}),'connections');
 assert.equal(resolveSettingsTab('instance',{isAdmin:true,instanceAdmin:true}),'instance');
 const ids=settingsSections(member).flatMap(s=>s.items.map(i=>i.id));
 assert.ok(!ids.includes('displays') && !ids.includes('members') && !ids.includes('instance'));
 assert.equal(new Set(ids).size,ids.length);
});
