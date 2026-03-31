export function getFormStringValue(form: FormData, key: string) {
    const value = form.get(key);
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

export function parseJsonMetadata(value: FormDataEntryValue | null) {
    if (typeof value !== "string") {
        return {};
    }
    try {
        return JSON.parse(value);
    } catch {
        return { raw: value };
    }
}
