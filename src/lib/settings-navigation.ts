/** Shared settings destinations. Existing ?tab= links remain valid. */
export const SETTINGS_SECTIONS = [
    { label: 'Personal', items: [
        { id:'profile', label:'Your profile', description:'Your name and role help agents know who to contact.' },
        { id:'notifications', label:'Notifications', description:'Choose when and where you receive updates.' },
    ] },
    { label: 'Workspace', items: [
        { id:'routines', label:'Agent routines', description:'Set the daily review and maintain shared operating rules.' },
        { id:'members', label:'People & access', description:'Manage people and their workspace permissions.', admin:true },
    ] },
    { label: 'Connections', items: [
        { id:'connections', label:'Agent connections', description:'Add agents or connect a runtime you already use.' },
        { id:'tokens', label:'Access tokens', description:'Manage credentials for agents and external connections.' },
        { id:'displays', label:'Displays', description:'Connect a physical display to your live agent feed.', admin:true },
    ] },
    { label: 'System', items: [
        { id:'updates', label:'Updates', description:'Check and manage the installed application version.' },
        { id:'advanced', label:'Advanced setup', description:'Manual runtime commands and connection diagnostics.' },
        { id:'instance', label:'Instance', description:'Settings for the entire self-hosted installation.', instanceAdmin:true },
    ] },
] as const;
export type SettingsTab = typeof SETTINGS_SECTIONS[number]['items'][number]['id'];
export function settingsSections({isAdmin,instanceAdmin}:{isAdmin:boolean;instanceAdmin:boolean}) {
    return SETTINGS_SECTIONS.map(section => ({...section,items:section.items.filter(item => (!('admin' in item) || isAdmin) && (!('instanceAdmin' in item) || instanceAdmin))})).filter(section => section.items.length);
}
export function resolveSettingsTab(value:string|null, access:{isAdmin:boolean;instanceAdmin:boolean}):SettingsTab {
    return settingsSections(access).flatMap(section=>section.items).find(item=>item.id===value)?.id ?? 'connections';
}
