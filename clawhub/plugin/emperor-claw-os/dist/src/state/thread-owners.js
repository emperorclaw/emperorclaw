import fs from "node:fs";
export function loadThreadOwners(paths) {
    try {
        return JSON.parse(fs.readFileSync(paths.threadOwnerPath, "utf8"));
    }
    catch {
        return {};
    }
}
export function saveThreadOwners(paths, owners) {
    fs.writeFileSync(paths.threadOwnerPath, `${JSON.stringify(owners, null, 2)}\n`, "utf8");
}
export function setThreadOwner(paths, threadId, agentId) {
    const owners = loadThreadOwners(paths);
    owners[threadId] = agentId;
    saveThreadOwners(paths, owners);
}
export function clearThreadOwner(paths, threadId) {
    const owners = loadThreadOwners(paths);
    delete owners[threadId];
    saveThreadOwners(paths, owners);
}
