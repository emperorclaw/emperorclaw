import type { ModuleState } from "@/lib/modules";

/**
 * Shared settings destinations. Existing ?tab= links remain valid. A tab with a module hides while that module is off.
 * Labels are the English source copy; the UI shows `settings.sections.<id>` and `settings.items.<item key>`
 * (settingsItemKey) from messages, kept equal to these by tests/unit/i18n-parity.test.ts.
 */
export const SETTINGS_SECTIONS = [
    { id: 'personal', label: 'Personal', items: [
        { id:'profile', label:'Your profile', description:'Your name and role help agents know who to contact.' },
        { id:'notifications', label:'Notifications', description:'Choose when and where you receive updates.' },
    ] },
    { id: 'workspace', label: 'Workspace', items: [
        { id:'routines', label:'Agent routines', description:'Set the daily review and maintain shared operating rules.' },
        { id:'members', label:'People & access', description:'Manage people and their workspace permissions.', admin:true },
        { id:'direct-chats', label:'Direct chats', description:'Choose whether direct chats with agents are shared or private.', admin:true },
        { id:'modules', label:'Modules', description:'Turn parts of Emperor on or off for this company. Data is kept.', admin:true },
    ] },
    { id: 'connections', label: 'Connections', items: [
        { id:'connections', label:'Agent connections', description:'Add agents or connect a runtime you already use.' },
        { id:'tokens', label:'Access tokens', description:'Manage credentials for agents and external connections.' },
        { id:'runtime-hosts', label:'Runtime hosts', description:'Machines that run your Hermes agents: connect, check and restart.', admin:true },
        { id:'displays', label:'Displays', description:'Connect a physical display to your live agent feed.', admin:true, module:'displays' },
    ] },
    { id: 'system', label: 'System', items: [
        { id:'updates', label:'Updates', description:'Check and manage the installed application version.' },
        { id:'advanced', label:'Advanced setup', description:'Manual runtime commands and connection diagnostics.' },
        { id:'instance', label:'Instance', description:'Settings for the entire self-hosted installation.', instanceAdmin:true },
    ] },
] as const;
export type SettingsTab = typeof SETTINGS_SECTIONS[number]['items'][number]['id'];
export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id'];

type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}` ? `${Head}${Capitalize<CamelCase<Tail>>}` : S;
export type SettingsItemKey = CamelCase<SettingsTab>;

/** The message key of a settings tab: "runtime-hosts" → "runtimeHosts". */
export function settingsItemKey(id: SettingsTab): SettingsItemKey {
    return id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) as SettingsItemKey;
}
type SettingsAccess = {isAdmin:boolean;instanceAdmin:boolean;modules?:ModuleState|null};
export function settingsSections({isAdmin,instanceAdmin,modules}:SettingsAccess) {
    return SETTINGS_SECTIONS.map(section => ({...section,items:section.items.filter(item => (!('admin' in item) || isAdmin) && (!('instanceAdmin' in item) || instanceAdmin) && (!('module' in item) || !modules || modules[item.module]))})).filter(section => section.items.length);
}
export function resolveSettingsTab(value:string|null, access:SettingsAccess):SettingsTab {
    return settingsSections(access).flatMap(section=>section.items).find(item=>item.id===value)?.id ?? 'connections';
}
