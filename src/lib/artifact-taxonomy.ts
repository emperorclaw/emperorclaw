export const DEFAULT_ARTIFACT_CLASS = "working_file";
export const DEFAULT_ARTIFACT_IMPORTANCE = "operational";

export const ARTIFACT_CLASS_OPTIONS = [
    {
        value: "working_file",
        label: "Working file",
        description: "General working material, drafts, and in-progress outputs.",
    },
    {
        value: "deliverable",
        label: "Deliverable",
        description: "A finished output intended for review, handoff, or delivery.",
    },
    {
        value: "source_document",
        label: "Source document",
        description: "Reference input material that informed the work.",
    },
    {
        value: "proof",
        label: "Proof",
        description: "Evidence, screenshots, receipts, logs, or verification material.",
    },
    {
        value: "template",
        label: "Template",
        description: "Reusable starting point or boilerplate asset.",
    },
    {
        value: "export_bundle",
        label: "Export bundle",
        description: "Packaged export or archive assembled for transfer.",
    },
] as const;

export const ARTIFACT_IMPORTANCE_OPTIONS = [
    {
        value: "operational",
        label: "Operational",
        description: "Useful working context for current execution.",
    },
    {
        value: "record",
        label: "Record",
        description: "Worth retaining as part of the durable project record.",
    },
    {
        value: "canonical",
        label: "Canonical",
        description: "The authoritative artifact people should trust first.",
    },
    {
        value: "temporary",
        label: "Temporary",
        description: "Short-lived material that may not matter later.",
    },
] as const;

export function getArtifactClassLabel(value?: string | null) {
    return getOptionLabel(ARTIFACT_CLASS_OPTIONS, value, "Unclassified");
}

export function getArtifactImportanceLabel(value?: string | null) {
    return getOptionLabel(ARTIFACT_IMPORTANCE_OPTIONS, value, "Operational");
}

function getOptionLabel(
    options: ReadonlyArray<{ value: string; label: string }>,
    value: string | null | undefined,
    fallback: string
) {
    if (!value) {
        return fallback;
    }
    const match = options.find((option) => option.value === value);
    if (match) {
        return match.label;
    }
    return humanizeSlug(value);
}

function humanizeSlug(value: string) {
    return value
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
