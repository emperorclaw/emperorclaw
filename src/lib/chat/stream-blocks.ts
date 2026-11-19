/** Split completed paragraphs/code blocks so only the last block reparses. */
export function streamBlocks(text: string): string[] {
    const blocks: string[] = [];
    let current: string[] = [];
    let fence: string | null = null;
    for (const line of text.split("\n")) {
        const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        }
        current.push(line);
        if (!fence && !line.trim() && blocks.length < 255) {
            if (current.join("\n").trim()) blocks.push(current.join("\n"));
            current = [];
        }
    }
    if (current.length) blocks.push(current.join("\n"));
    return blocks;
}
