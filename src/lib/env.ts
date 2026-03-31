export function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export function optionalEnv(name: string): string | undefined {
    const value = process.env[name];
    if (value === undefined || value === null) {
        return undefined;
    }
    return value === "" ? undefined : value;
}
