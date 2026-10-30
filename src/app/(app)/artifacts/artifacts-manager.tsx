"use client";

import {
    startTransition,
    useDeferredValue,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type MutableRefObject,
    type ReactNode,
    type SetStateAction,
    type ChangeEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { IconArrowDown, IconChevronDown, IconChevronRight, IconFile, IconFilePlus, IconFileZip, IconFileCode, IconPhoto, IconFileTypeJs, IconFileSpreadsheet, IconFileText, IconFolder, IconFolderOpen, IconFolderPlus, IconLoader2, IconArrowsMaximize, IconDots, IconPencil, IconPlus, IconQuestionMark, IconRefresh, IconDeviceFloppy, IconSearch, IconSettings, IconTrash, IconUpload } from "@tabler/icons-react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "next-intl";

function PreviewLoading({ kind }: { kind: "spreadsheet" | "document" }) {
    const t = useTranslations("artifacts.preview");
    return <div className="text-xs text-zinc-500 p-4">{kind === "spreadsheet" ? t("loadingSpreadsheet") : t("loadingDocument")}</div>;
}

const XlsxViewer = dynamic(
    () => import("@extend-ai/react-xlsx").then((mod) => mod.XlsxViewer),
    { ssr: false, loading: () => <PreviewLoading kind="spreadsheet" /> }
);
const ReactDocxViewer = dynamic(
    () => import("@extend-ai/react-docx").then((mod) => mod.ReactDocxViewer),
    { ssr: false, loading: () => <PreviewLoading kind="document" /> }
);
import { PageHeader } from "@/components/page-header";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
    ARTIFACT_CLASS_OPTIONS,
    ARTIFACT_IMPORTANCE_OPTIONS,
    DEFAULT_ARTIFACT_CLASS,
    DEFAULT_ARTIFACT_IMPORTANCE,
    getArtifactClassLabel,
    getArtifactImportanceLabel,
} from "@/lib/artifact-taxonomy";
import { cn } from "@/lib/utils";

type ProjectOption = {
    id: string;
    name: string;
    customerId: string | null;
};

type TaskOption = {
    id: string;
    type: string;
    projectId: string;
};

type CustomerOption = {
    id: string;
    name: string;
};

type FolderSummary = {
    id: string;
    name: string;
    path: string;
    projectId: string | null;
    customerId: string | null;
    metadataJson: Record<string, unknown>;
    createdAt?: string;
};

type ArtifactSummary = {
    id: string;
    title: string | null;
    kind: string;
    artifactClass: string;
    importance: string;
    contentType: string;
    contentText?: string | null;
    previewText?: string | null;
    storageKey?: string | null;
    storageUrl?: string | null;
    originalFilename?: string | null;
    sizeBytes: number;
    sha256?: string | null;
    metadataJson?: Record<string, unknown>;
    isCanonical?: boolean;
    updatedAt?: string;
    createdAt: string;
    folderId?: string | null;
    path?: string | null;
    projectId: string | null;
    projectGoal?: string | null;
    customerId: string | null;
    customerName?: string | null;
    agentId?: string | null;
    taskId: string | null;
    taskType?: string | null;
};

type ArtifactDetail = ArtifactSummary & {
    companyId?: string;
    agentId: string | null;
    contentText: string | null;
    previewText: string | null;
    searchText?: string | null;
    storageProvider?: string | null;
    sourceKind?: string | null;
    sourceRef?: string | null;
    visibility?: string;
    promotedAt?: string | null;
    retentionPolicy?: string | null;
};

type FolderContentsResponse = {
    folder: FolderSummary;
    ancestors: Array<Pick<FolderSummary, "id" | "name" | "path">>;
    folders: FolderSummary[];
    artifacts: ArtifactSummary[];
    discoveredEntries: DiscoveredStorageEntry[];
    discoveryEnabled: boolean;
};

type DiscoveredStorageEntry = {
    name: string;
    logicalPath: string;
    entryType: "file" | "folder";
    sizeBytes: number | null;
    modifiedAt: string;
    contentType: string | null;
};

type SelectedEntry =
    | { type: "folder"; id: string }
    | { type: "artifact"; id: string }
    | null;

type ArtifactDraft = {
    title: string;
    kind: string;
    artifactClass: string;
    importance: string;
    visibility: string;
    retentionPolicy: string;
    projectId: string;
    taskId: string;
    customerId: string;
    metadataJson: string;
    isCanonical: boolean;
};

type ArtifactLocationDraft = {
    name: string;
    folderId: string;
};

type FolderDraft = {
    name: string;
    parentFolderId: string;
    projectId: string;
    customerId: string;
    metadataJson: string;
};

type CreatableFileType = "xlsx" | "docx" | "csv" | "markdown" | "text" | "json";

type NewFileDraft = {
    name: string;
    type: CreatableFileType;
    projectId: string;
    customerId: string;
};

type RenameFileDraft = {
    artifactId: string;
    baseName: string;
    extension: string;
    folderId: string;
};

type PreviewState =
    | { state: "idle" }
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "markdown"; text: string }
    | { state: "json"; text: string }
    | { state: "text"; text: string }
    | { state: "csv"; rows: string[][]; text: string }
    | { state: "image"; url: string }
    | { state: "pdf"; url: string }
    | { state: "office"; url: string; name: string; id: string; isEditable: boolean }
    | { state: "xlsx-preview"; bytes: ArrayBuffer; name: string; id: string }
    | { state: "docx-preview"; bytes: ArrayBuffer; name: string; id: string }
    | { state: "unsupported"; message: string };

const ROOT_ID = "root";
/** File browser columns: name + actions on phones; context, size and date join from md. */
const BROWSER_GRID = "grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_120px_140px_80px]";

const DEFAULT_ARTIFACT_DRAFT: ArtifactDraft = {
    title: "",
    kind: "report",
    artifactClass: DEFAULT_ARTIFACT_CLASS,
    importance: DEFAULT_ARTIFACT_IMPORTANCE,
    visibility: "private",
    retentionPolicy: "",
    projectId: "",
    taskId: "",
    customerId: "",
    metadataJson: "{}",
    isCanonical: false,
};

const DEFAULT_LOCATION_DRAFT: ArtifactLocationDraft = {
    name: "",
    folderId: ROOT_ID,
};

const DEFAULT_FOLDER_DRAFT: FolderDraft = {
    name: "",
    parentFolderId: ROOT_ID,
    projectId: "",
    customerId: "",
    metadataJson: "{}",
};

// Each type's label and description: artifacts.fileTypes.{value} in messages/*.json.
const CREATABLE_FILE_TYPES: Array<{
    value: CreatableFileType;
    extension: string;
    contentType: string;
    initialContent: string | null;
    editor: "office" | "csv" | "text";
}> = [
    { value: "xlsx", extension: ".xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", initialContent: null, editor: "office" },
    { value: "docx", extension: ".docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", initialContent: null, editor: "office" },
    { value: "csv", extension: ".csv", contentType: "text/csv;charset=utf-8", initialContent: "", editor: "csv" },
    { value: "markdown", extension: ".md", contentType: "text/markdown;charset=utf-8", initialContent: "", editor: "text" },
    { value: "text", extension: ".txt", contentType: "text/plain;charset=utf-8", initialContent: "", editor: "text" },
    { value: "json", extension: ".json", contentType: "application/json;charset=utf-8", initialContent: "{}\n", editor: "text" },
];

type Props = {
    projects: ProjectOption[];
    tasks: TaskOption[];
    customers: CustomerOption[];
};

/** The hash algorithm's name: never translated. */
const HASH_LABEL = "SHA256";
/** The default name a new file of this type gets (a file name, so never translated). */
const untitledFileName = (type: CreatableFileType) => `untitled${getCreatableFileType(type).extension}`;

/** File kinds the filters and forms offer (stored values; the labels are artifacts.kinds.*). */
const ARTIFACT_KINDS = ["report", "invoice", "statement", "document", "export"] as const;

export default function ArtifactsManager({ projects, tasks, customers }: Props) {
    const t = useTranslations("artifacts");
    const formatDate = useRelativeDate();
    const linkedArtifactId = useSearchParams().get("artifact");
    const router = useRouter();
    const [currentFolderId, setCurrentFolderId] = useState(ROOT_ID);
    const [selectedEntry, setSelectedEntry] = useState<SelectedEntry>(null);
    const [folderCache, setFolderCache] = useState<Record<string, FolderContentsResponse>>({});
    const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({ [ROOT_ID]: true });
    const [searchValue, setSearchValue] = useState("");
    const [projectFilter, setProjectFilter] = useState("");
    const [taskFilter, setTaskFilter] = useState("");
    const [customerFilter, setCustomerFilter] = useState("");
    const [kindFilter, setKindFilter] = useState("");
    const [globalArtifacts, setGlobalArtifacts] = useState<ArtifactSummary[]>([]);
    const [isSearchLoading, setIsSearchLoading] = useState(false);
    const [loadingFolderId, setLoadingFolderId] = useState<string | null>(ROOT_ID);
    const [artifactDetail, setArtifactDetail] = useState<ArtifactDetail | null>(null);
    const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
    const [inspectorTab, setInspectorTab] = useState("preview");
    const [artifactDraft, setArtifactDraft] = useState<ArtifactDraft>(DEFAULT_ARTIFACT_DRAFT);
    const [artifactLocationDraft, setArtifactLocationDraft] = useState<ArtifactLocationDraft>(DEFAULT_LOCATION_DRAFT);
    const [folderDraft, setFolderDraft] = useState<FolderDraft>(DEFAULT_FOLDER_DRAFT);
    const [isSavingArtifact, setIsSavingArtifact] = useState(false);
    const [isSavingLocation, setIsSavingLocation] = useState(false);
    const [isSavingFolder, setIsSavingFolder] = useState(false);
    const [isPreviewDialogOpen, setIsPreviewDialogOpen] = useState(false);
    const [previewDialogTab, setPreviewDialogTab] = useState("preview");
    const [deleteConfirm, setDeleteConfirm] = useState<null | {
        type: "folder" | "file" | "external";
        id: string;
        entryType?: "file" | "folder";
        title: string;
        description: string;
    }>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [csvEditorRows, setCsvEditorRows] = useState<string[][]>([]);
    const [csvRawDraft, setCsvRawDraft] = useState("");
    const [csvSourceText, setCsvSourceText] = useState("");
    const [csvRawError, setCsvRawError] = useState<string | null>(null);
    const [textEditorDraft, setTextEditorDraft] = useState("");
    const [textSourceText, setTextSourceText] = useState("");
    const [textEditorError, setTextEditorError] = useState<string | null>(null);
    const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
    const [isNewFileOpen, setIsNewFileOpen] = useState(false);
    const [newFileDraft, setNewFileDraft] = useState<NewFileDraft>({ name: "untitled.csv", type: "csv", projectId: "", customerId: "" });
    const [newFileFolderId, setNewFileFolderId] = useState(ROOT_ID);
    const [isCreatingFile, setIsCreatingFile] = useState(false);
    const [renameFileDraft, setRenameFileDraft] = useState<RenameFileDraft | null>(null);
    const [isRenamingFile, setIsRenamingFile] = useState(false);
    const [isInspectorOpen, setIsInspectorOpen] = useState(false);
    const [isUploadOpen, setIsUploadOpen] = useState(false);
    const [externalToTrack, setExternalToTrack] = useState<DiscoveredStorageEntry | null>(null);
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploadTitle, setUploadTitle] = useState("");
    const [uploadKind, setUploadKind] = useState("report");
    const [uploadArtifactClass, setUploadArtifactClass] = useState(DEFAULT_ARTIFACT_CLASS);
    const [uploadImportance, setUploadImportance] = useState(DEFAULT_ARTIFACT_IMPORTANCE);
    const [uploadProjectId, setUploadProjectId] = useState("");
    const [uploadTaskId, setUploadTaskId] = useState("");
    const [uploadCustomerId, setUploadCustomerId] = useState("");
    const [uploadMetadataJson, setUploadMetadataJson] = useState("{}");
    const [isUploading, setIsUploading] = useState(false);
    const replaceInputRef = useRef<HTMLInputElement | null>(null);
    const previewUrlRef = useRef<string | null>(null);
    const previewRequestRef = useRef(0);
    const pendingEditorTabRef = useRef<"table" | "edit" | null>(null);
    const deferredSearch = useDeferredValue(searchValue);
    const requestedFolderIdsRef = useRef<Set<string>>(new Set());

    const currentContents = folderCache[currentFolderId];
    const isSearchMode = Boolean(
        deferredSearch.trim() ||
        projectFilter ||
        taskFilter ||
        customerFilter ||
        kindFilter
    );
    const hasActiveFilters = Boolean(
        searchValue.trim() ||
        projectFilter ||
        taskFilter ||
        customerFilter ||
        kindFilter
    );

    const visibleFolders = isSearchMode ? [] : currentContents?.folders ?? [];
    const visibleArtifacts = isSearchMode ? globalArtifacts : currentContents?.artifacts ?? [];
    const visibleDiscoveredEntries = isSearchMode ? [] : currentContents?.discoveredEntries ?? [];
    const selectedArtifactUpdatedAt = artifactDetail?.updatedAt;
    const selectedFolder = selectedEntry?.type === "folder"
        ? findFolderById(folderCache, selectedEntry.id)
        : null;
    const knownFolders = buildKnownFolders(folderCache, t("root"));
    const availableTasks = tasks.filter((task) => task.projectId === uploadProjectId);
    const hasFolderChanges = Boolean(
        selectedFolder &&
        selectedFolder.id !== ROOT_ID &&
        (
            folderDraft.name.trim() !== selectedFolder.name ||
            folderDraft.parentFolderId !== (getParentFolderId(selectedFolder.id, folderCache) ?? ROOT_ID) ||
            folderDraft.projectId !== (selectedFolder.projectId ?? "") ||
            folderDraft.customerId !== (selectedFolder.customerId ?? "") ||
            normalizeJsonInput(folderDraft.metadataJson) !== normalizeJsonValue(selectedFolder.metadataJson || {})
        )
    );
    const hasArtifactPropertyChanges = Boolean(
        artifactDetail &&
        (
            artifactDraft.title.trim() !== (artifactDetail.title ?? artifactDetail.originalFilename ?? "") ||
            artifactDraft.kind.trim() !== artifactDetail.kind ||
            artifactDraft.artifactClass !== artifactDetail.artifactClass ||
            artifactDraft.importance !== artifactDetail.importance ||
            artifactDraft.visibility !== (artifactDetail.visibility ?? "private") ||
            artifactDraft.retentionPolicy.trim() !== (artifactDetail.retentionPolicy ?? "") ||
            artifactDraft.projectId !== (artifactDetail.projectId ?? "") ||
            artifactDraft.taskId !== (artifactDetail.taskId ?? "") ||
            artifactDraft.customerId !== (artifactDetail.customerId ?? "") ||
            artifactDraft.isCanonical !== Boolean(artifactDetail.isCanonical) ||
            normalizeJsonInput(artifactDraft.metadataJson) !== normalizeJsonValue(artifactDetail.metadataJson || {})
        )
    );
    const hasArtifactLocationChanges = Boolean(
        artifactDetail &&
        (
            artifactLocationDraft.name.trim() !== (artifactDetail.originalFilename || deriveDisplayName(artifactDetail)) ||
            artifactLocationDraft.folderId !== (artifactDetail.folderId ?? ROOT_ID)
        )
    );
    const isCsvDirty = normalizeTextForCompare(csvRawDraft) !== normalizeTextForCompare(csvSourceText);
    const isTextArtifact = preview.state === "markdown" || preview.state === "json" || preview.state === "text";
    const isTextDirty = normalizeTextForCompare(textEditorDraft) !== normalizeTextForCompare(textSourceText);

    async function loadFolder(folderId: string, options?: { silent?: boolean }) {
        requestedFolderIdsRef.current.add(folderId);
        if (!options?.silent) {
            setLoadingFolderId(folderId);
        }
        try {
            const params = new URLSearchParams();
            if (folderId !== ROOT_ID) {
                params.set("folderId", folderId);
            }
            const response = await fetch(`/api/ui/folders/contents?${params.toString()}`, {
                cache: "no-store",
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.fetchFolder")));
            }
            const payload = await response.json() as FolderContentsResponse;
            const cacheKey = folderId === ROOT_ID ? ROOT_ID : payload.folder.id;
            startTransition(() => {
                setFolderCache((current) => ({
                    ...current,
                    [cacheKey]: payload,
                }));
            });
            return payload;
        } finally {
            if (!options?.silent) {
                setLoadingFolderId((current) => current === folderId ? null : current);
            }
        }
    }

    async function reloadWorkspace(targetFolderId = currentFolderId) {
        await loadFolder(ROOT_ID, { silent: true });
        if (targetFolderId === ROOT_ID) {
            return;
        }

        const targetPayload = await loadFolder(targetFolderId, { silent: true });
        const ancestorIds = targetPayload.ancestors.map((ancestor) => ancestor.id);
        for (const ancestorId of ancestorIds) {
            await loadFolder(ancestorId, { silent: true });
        }
        setExpandedFolders((current) => {
            const next = { ...current, [ROOT_ID]: true, [targetFolderId]: true };
            for (const ancestorId of ancestorIds) {
                next[ancestorId] = true;
            }
            return next;
        });
    }

    useEffect(() => {
        const id = linkedArtifactId;
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
        // A deep link (e.g. from a chat message) opens the file itself, not just the root folder.
        setSelectedEntry({ type: "artifact", id });
        setInspectorTab("preview");
        setIsInspectorOpen(true);
        let cancelled = false;
        void fetch(`/api/ui/artifacts/${id}`, { cache: "no-store" })
            .then((response) => response.ok ? response.json() as Promise<{ artifact: ArtifactDetail }> : null)
            .then((payload) => {
                const folderId = payload?.artifact.folderId;
                if (cancelled || !folderId) return;
                setCurrentFolderId(folderId);
                void reloadWorkspace(folderId).catch(() => undefined);
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkedArtifactId]);

    async function fetchArtifactDetail(artifactId: string) {
        const response = await fetch(`/api/ui/artifacts/${artifactId}`, {
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error(await readError(response, t("errors.fetchFile")));
        }
        const payload = await response.json() as { artifact: ArtifactDetail };
        setArtifactDetail(payload.artifact);
        return payload.artifact;
    }

    async function fetchSearchResults() {
        const params = new URLSearchParams();
        if (deferredSearch.trim()) params.set("search", deferredSearch.trim());
        if (projectFilter) params.set("projectId", projectFilter);
        if (taskFilter) params.set("taskId", taskFilter);
        if (customerFilter) params.set("customerId", customerFilter);
        if (kindFilter) params.set("kind", kindFilter);

        setIsSearchLoading(true);
        try {
            const response = await fetch(`/api/ui/artifacts?${params.toString()}`, {
                cache: "no-store",
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.search")));
            }
            const payload = await response.json() as { artifacts: ArtifactSummary[] };
            setGlobalArtifacts(payload.artifacts);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.search"));
        } finally {
            setIsSearchLoading(false);
        }
    }

    useEffect(() => {
        void loadFolder(ROOT_ID);
    }, []);

    useEffect(() => {
        if (!requestedFolderIdsRef.current.has(currentFolderId)) {
            void loadFolder(currentFolderId);
        }
    }, [currentFolderId]);

    useEffect(() => {
        if (!currentContents?.discoveryEnabled) return;
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                void loadFolder(currentFolderId, { silent: true }).then((payload) => {
                    if (selectedEntry?.type !== "artifact") return;
                    const refreshedArtifact = payload.artifacts.find((artifact) => artifact.id === selectedEntry.id);
                    if (!refreshedArtifact) return;
                    if (!selectedArtifactUpdatedAt || String(refreshedArtifact.updatedAt) !== String(selectedArtifactUpdatedAt)) {
                        void fetchArtifactDetail(selectedEntry.id);
                    }
                });
            }
        }, 5000);
        return () => window.clearInterval(timer);
    }, [currentFolderId, currentContents?.discoveryEnabled, selectedEntry?.type, selectedEntry?.id, selectedArtifactUpdatedAt]);

    useEffect(() => {
        if (!selectedEntry && currentFolderId === ROOT_ID && folderCache[ROOT_ID]) {
            setSelectedEntry({ type: "folder", id: ROOT_ID });
        }
    }, [selectedEntry, currentFolderId, folderCache]);

    useEffect(() => {
        if (isSearchMode) {
            void fetchSearchResults();
            return;
        }
        setGlobalArtifacts([]);
        setIsSearchLoading(false);
    }, [deferredSearch, projectFilter, taskFilter, customerFilter, kindFilter, isSearchMode]);

    useEffect(() => {
        if (selectedEntry?.type !== "artifact") {
            setArtifactDetail(null);
            setPreview({ state: "idle" });
            return;
        }
        void fetchArtifactDetail(selectedEntry.id).catch((error) => {
            setArtifactDetail(null);
            setPreview({
                state: "error",
                message: error instanceof Error ? error.message : t("errors.fetchFile"),
            });
        });
    }, [selectedEntry?.type, selectedEntry?.id]);

    useEffect(() => {
        if (!selectedFolder) {
            setFolderDraft(DEFAULT_FOLDER_DRAFT);
            return;
        }
        const parentFolderId = getParentFolderId(selectedFolder.id, folderCache);
        setFolderDraft({
            name: selectedFolder.name,
            parentFolderId: parentFolderId ?? ROOT_ID,
            projectId: selectedFolder.projectId ?? "",
            customerId: selectedFolder.customerId ?? "",
            metadataJson: formatJson(selectedFolder.metadataJson || {}),
        });
    }, [selectedFolder?.id, selectedFolder?.name, selectedFolder?.path, selectedFolder?.projectId, selectedFolder?.customerId]);

    useEffect(() => {
        if (!artifactDetail) {
            setArtifactDraft(DEFAULT_ARTIFACT_DRAFT);
            setArtifactLocationDraft(DEFAULT_LOCATION_DRAFT);
            setIsPreviewDialogOpen(false);
            setPreviewDialogTab("preview");
            setCsvEditorRows([]);
            setCsvRawDraft("");
            setCsvSourceText("");
            setCsvRawError(null);
            setTextEditorDraft("");
            setTextSourceText("");
            setTextEditorError(null);
            return;
        }
        setArtifactDraft({
            title: artifactDetail.title ?? artifactDetail.originalFilename ?? "",
            kind: artifactDetail.kind,
            artifactClass: artifactDetail.artifactClass,
            importance: artifactDetail.importance,
            visibility: artifactDetail.visibility ?? "private",
            retentionPolicy: artifactDetail.retentionPolicy ?? "",
            projectId: artifactDetail.projectId ?? "",
            taskId: artifactDetail.taskId ?? "",
            customerId: artifactDetail.customerId ?? "",
            metadataJson: formatJson(artifactDetail.metadataJson || {}),
            isCanonical: Boolean(artifactDetail.isCanonical),
        });
        setArtifactLocationDraft({
            name: artifactDetail.originalFilename || deriveDisplayName(artifactDetail),
            folderId: artifactDetail.folderId ?? ROOT_ID,
        });
    }, [artifactDetail?.id, artifactDetail?.updatedAt]);

    useEffect(() => {
        if (preview.state !== "csv") {
            setCsvEditorRows([]);
            setCsvRawDraft("");
            setCsvSourceText("");
            setCsvRawError(null);
            if (previewDialogTab !== "preview") {
                setPreviewDialogTab("preview");
            }
            return;
        }

        const normalizedRows = normalizeCsvRows(parseCsvDocument(preview.text));
        setCsvEditorRows(normalizedRows);
        setCsvRawDraft(preview.text);
        setCsvSourceText(preview.text);
        setCsvRawError(null);
        if (pendingEditorTabRef.current === "table") {
            setPreviewDialogTab("table");
            pendingEditorTabRef.current = null;
        }
    }, [artifactDetail?.id, preview]);

    useEffect(() => {
        if (preview.state !== "markdown" && preview.state !== "json" && preview.state !== "text") {
            setTextEditorDraft("");
            setTextSourceText("");
            setTextEditorError(null);
            return;
        }

        setTextEditorDraft(preview.text);
        setTextSourceText(preview.text);
        setTextEditorError(null);
        if (pendingEditorTabRef.current === "edit") {
            setPreviewDialogTab("edit");
            pendingEditorTabRef.current = null;
        }
    }, [artifactDetail?.id, preview]);

    useEffect(() => {
        if (!artifactDetail) {
            clearPreviewUrl(previewUrlRef);
            return;
        }

        const activeArtifact = artifactDetail;

        const requestId = previewRequestRef.current + 1;
        previewRequestRef.current = requestId;
        clearPreviewUrl(previewUrlRef);

        async function loadPreview() {
            setPreview({ state: "loading" });

            try {
                const previewMode = getPreviewMode(activeArtifact);
                if (previewMode === "markdown" || previewMode === "json" || previewMode === "text" || previewMode === "csv") {
                    const text = activeArtifact.contentText || await fetchArtifactText(activeArtifact.id);
                    if (previewRequestRef.current !== requestId) {
                        return;
                    }
                    if (previewMode === "markdown") {
                        setPreview({ state: "markdown", text });
                        return;
                    }
                    if (previewMode === "json") {
                        setPreview({ state: "json", text: formatJsonSafely(text) });
                        return;
                    }
                    if (previewMode === "csv") {
                        setPreview({ state: "csv", rows: parseCsvPreview(text), text });
                        return;
                    }
                    setPreview({ state: "text", text });
                    return;
                }

                if (previewMode === "image" || previewMode === "pdf" || previewMode === "office") {
                    const blob = await fetchArtifactBlob(activeArtifact.id);
                    if (previewRequestRef.current !== requestId) {
                        return;
                    }
                    const objectUrl = URL.createObjectURL(blob);
                    previewUrlRef.current = objectUrl;
                    if (previewMode === "image") {
                        setPreview({ state: "image", url: objectUrl });
                    } else if (previewMode === "pdf") {
                        setPreview({ state: "pdf", url: objectUrl });
                    } else {
                        const name = activeArtifact.originalFilename || deriveDisplayName(activeArtifact);
                        const isXlsx = name.toLowerCase().endsWith(".xlsx");
                        const isDocx = name.toLowerCase().endsWith(".docx");
                        if (isXlsx) {
                            const bytes = await blob.arrayBuffer();
                            if (previewRequestRef.current !== requestId) return;
                            setPreview({
                                state: "xlsx-preview",
                                bytes,
                                name,
                                id: activeArtifact.id,
                            });
                        } else if (isDocx) {
                            const bytes = await blob.arrayBuffer();
                            if (previewRequestRef.current !== requestId) return;
                            setPreview({
                                state: "docx-preview",
                                bytes,
                                name,
                                id: activeArtifact.id,
                            });
                        } else {
                            setPreview({
                                state: "office",
                                url: objectUrl,
                                name,
                                id: activeArtifact.id,
                                isEditable: false,
                            });
                        }
                    }
                    return;
                }

                setPreview({
                    state: "unsupported",
                    message: t("preview.unavailable", { type: activeArtifact.contentType }),
                });
            } catch (error) {
                if (previewRequestRef.current === requestId) {
                    setPreview({
                        state: "error",
                        message: error instanceof Error ? error.message : t("errors.preview"),
                    });
                }
            }
        }

        void loadPreview();
        return () => {
            clearPreviewUrl(previewUrlRef);
        };
    }, [artifactDetail?.id, artifactDetail?.contentType, artifactDetail?.updatedAt]);

    async function handleCreateFolder() {
        if (!folderDraft.name.trim()) {
            toast.error(t("folderNameRequired"));
            return;
        }

        setIsSavingFolder(true);
        try {
            const response = await fetch("/api/ui/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: folderDraft.name.trim(),
                    parentFolderId: folderDraft.parentFolderId === ROOT_ID ? null : folderDraft.parentFolderId,
                    projectId: folderDraft.projectId || null,
                    customerId: folderDraft.customerId || null,
                    metadataJson: parseJsonInput(folderDraft.metadataJson),
                }),
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.createFolder")));
            }
            const payload = await response.json() as { folder: FolderSummary };
            setIsCreateFolderOpen(false);
            setSelectedEntry({ type: "folder", id: payload.folder.id });
            setCurrentFolderId(payload.folder.id);
            await reloadWorkspace(payload.folder.id);
            toast.success(t("toasts.folderCreated"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.createFolder"));
        } finally {
            setIsSavingFolder(false);
        }
    }

    async function handleSaveFolder() {
        if (!selectedFolder || selectedFolder.id === ROOT_ID) {
            return;
        }

        setIsSavingFolder(true);
        try {
            const response = await fetch(`/api/ui/folders/${selectedFolder.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: folderDraft.name.trim(),
                    parentFolderId: folderDraft.parentFolderId === ROOT_ID ? null : folderDraft.parentFolderId,
                    projectId: folderDraft.projectId || null,
                    customerId: folderDraft.customerId || null,
                    metadataJson: parseJsonInput(folderDraft.metadataJson),
                }),
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.saveFolder")));
            }
            await reloadWorkspace(selectedFolder.id);
            toast.success(t("toasts.folderUpdated"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.saveFolder"));
        } finally {
            setIsSavingFolder(false);
        }
    }

    function requestDeleteFolder(folderId: string) {
        setDeleteConfirm({
            type: "folder",
            id: folderId,
            title: t("confirm.deleteFolderTitle"),
            description: t("confirm.deleteFolderDescription"),
        });
    }

    async function deleteFolder(folderId: string) {
        try {
            const response = await fetch(`/api/ui/folders/${folderId}`, {
                method: "DELETE",
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.deleteFolder")));
            }
            setSelectedEntry({ type: "folder", id: currentFolderId });
            await reloadWorkspace(currentFolderId);
            toast.success(t("toasts.folderDeleted"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.deleteFolder"));
        }
    }

    async function handleUpload() {
        if (!uploadFile) {
            toast.error(t("chooseFile"));
            return;
        }

        setIsUploading(true);
        try {
            const formData = new FormData();
            formData.set("file", uploadFile);
            if (uploadProjectId) {
                formData.set("projectId", uploadProjectId);
            }
            if (uploadTaskId) {
                formData.set("taskId", uploadTaskId);
            }
            if (uploadCustomerId) {
                formData.set("customerId", uploadCustomerId);
            }
            formData.set("kind", uploadKind);
            formData.set("artifactClass", uploadArtifactClass);
            formData.set("importance", uploadImportance);
            formData.set("title", uploadTitle || uploadFile.name);
            formData.set("metadataJson", uploadMetadataJson);
            if (currentFolderId !== ROOT_ID) {
                formData.set("folderId", currentFolderId);
            }

            const response = await fetch("/api/ui/artifacts/upload", {
                method: "POST",
                body: formData,
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.upload")));
            }
            const payload = await response.json() as { artifact: ArtifactSummary };
            setIsUploadOpen(false);
            resetUploadState(
                payload.artifact.projectId ?? "",
                payload.artifact.customerId ?? uploadCustomerId,
                setUploadFile,
                setUploadTitle,
                setUploadKind,
                setUploadArtifactClass,
                setUploadImportance,
                setUploadMetadataJson,
                setUploadProjectId,
                setUploadCustomerId,
                setUploadTaskId
            );
            setSelectedEntry({ type: "artifact", id: payload.artifact.id });
            await reloadWorkspace(currentFolderId);
            toast.success(t("toasts.uploaded"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.upload"));
        } finally {
            setIsUploading(false);
        }
    }

    async function handleSaveArtifactProperties() {
        if (!artifactDetail) {
            return;
        }

        setIsSavingArtifact(true);
        try {
            const response = await fetch(`/api/ui/artifacts/${artifactDetail.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: artifactDraft.title.trim(),
                    kind: artifactDraft.kind.trim(),
                    artifactClass: artifactDraft.artifactClass,
                    importance: artifactDraft.importance,
                    visibility: artifactDraft.visibility,
                    retentionPolicy: artifactDraft.retentionPolicy.trim() || null,
                    projectId: artifactDraft.projectId || null,
                    taskId: artifactDraft.taskId || null,
                    customerId: artifactDraft.customerId || null,
                    isCanonical: artifactDraft.isCanonical,
                    metadataJson: parseJsonInput(artifactDraft.metadataJson),
                }),
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.saveProperties")));
            }
            await fetchArtifactDetail(artifactDetail.id);
            if (isSearchMode) {
                await fetchSearchResults();
            } else {
                await reloadWorkspace(currentFolderId);
            }
            toast.success(t("toasts.propertiesUpdated"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.saveProperties"));
        } finally {
            setIsSavingArtifact(false);
        }
    }

    async function handleSaveArtifactLocation() {
        if (!artifactDetail) {
            return;
        }

        setIsSavingLocation(true);
        try {
            const response = await fetch(`/api/ui/artifacts/${artifactDetail.id}/move`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    folderId: artifactLocationDraft.folderId === ROOT_ID ? null : artifactLocationDraft.folderId,
                    name: artifactLocationDraft.name.trim(),
                }),
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.move")));
            }
            await fetchArtifactDetail(artifactDetail.id);
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success(t("toasts.locationUpdated"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.move"));
        } finally {
            setIsSavingLocation(false);
        }
    }

    async function handleReplaceArtifact(file: File) {
        if (!artifactDetail) {
            return false;
        }

        const formData = new FormData();
        formData.set("file", file);
        formData.set("title", artifactDraft.title.trim() || file.name);
        formData.set("name", artifactLocationDraft.name.trim() || file.name);
        formData.set("metadataJson", artifactDraft.metadataJson);
        if (artifactLocationDraft.folderId !== ROOT_ID) {
            formData.set("folderId", artifactLocationDraft.folderId);
        }

        setIsSavingArtifact(true);
        try {
            const response = await fetch(`/api/ui/artifacts/${artifactDetail.id}/replace`, {
                method: "PATCH",
                body: formData,
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.replace")));
            }
            await fetchArtifactDetail(artifactDetail.id);
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success(t("toasts.replaced"));
            return true;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.replace"));
            return false;
        } finally {
            setIsSavingArtifact(false);
        }
    }

    function updateCsvRows(nextRows: string[][]) {
        const normalizedRows = normalizeCsvRows(nextRows);
        setCsvEditorRows(normalizedRows);
        setCsvRawDraft(serializeCsv(normalizedRows));
        setCsvRawError(null);
    }

    function handleCsvCellChange(rowIndex: number, columnIndex: number, value: string) {
        updateCsvRows(
            csvEditorRows.map((row, currentRowIndex) =>
                currentRowIndex === rowIndex
                    ? row.map((cell, currentColumnIndex) => currentColumnIndex === columnIndex ? value : cell)
                    : row
            )
        );
    }

    function handleAddCsvRow() {
        const columnCount = getCsvColumnCount(csvEditorRows);
        updateCsvRows([...csvEditorRows, Array.from({ length: columnCount }, () => "")]);
    }

    function handleDeleteCsvRow(rowIndex: number) {
        const nextRows = csvEditorRows.filter((_, currentRowIndex) => currentRowIndex !== rowIndex);
        updateCsvRows(nextRows.length ? nextRows : [[""]]);
    }

    function handleAddCsvColumn() {
        updateCsvRows(csvEditorRows.map((row) => [...row, ""]));
    }

    function handleDeleteCsvColumn(columnIndex: number) {
        const columnCount = getCsvColumnCount(csvEditorRows);
        if (columnCount <= 1) {
            updateCsvRows(csvEditorRows.map(() => [""]));
            return;
        }
        updateCsvRows(csvEditorRows.map((row) => row.filter((_, currentColumnIndex) => currentColumnIndex !== columnIndex)));
    }

    function handleResetCsvDraft() {
        const normalizedRows = normalizeCsvRows(parseCsvDocument(csvSourceText));
        setCsvEditorRows(normalizedRows);
        setCsvRawDraft(csvSourceText);
        setCsvRawError(null);
    }

    function handleApplyRawCsvToGrid() {
        try {
            const normalizedRows = normalizeCsvRows(parseCsvDocument(csvRawDraft));
            setCsvEditorRows(normalizedRows);
            setCsvRawError(null);
            toast.success(t("toasts.csvRefreshed"));
        } catch (error) {
            const message = error instanceof Error ? error.message : t("errors.parseCsv");
            setCsvRawError(message);
            toast.error(message);
        }
    }

    async function handleSaveCsvDraft() {
        if (!artifactDetail) {
            return;
        }

        const nextFileName =
            artifactLocationDraft.name.trim() ||
            artifactDetail.originalFilename ||
            `${deriveDisplayName(artifactDetail)}.csv`;
        const file = new window.File([csvRawDraft], nextFileName, { type: "text/csv;charset=utf-8" });
        const didReplace = await handleReplaceArtifact(file);
        if (didReplace) {
            setCsvSourceText(csvRawDraft);
            setCsvRawError(null);
            setPreviewDialogTab("preview");
        }
    }

    async function handleSaveTextDraft() {
        if (!artifactDetail || !isTextArtifact) {
            return;
        }

        let nextText = textEditorDraft;
        if (preview.state === "json") {
            try {
                nextText = JSON.stringify(JSON.parse(textEditorDraft), null, 2);
            } catch (error) {
                const message = error instanceof Error ? error.message : t("errors.invalidJson");
                setTextEditorError(message);
                return;
            }
        }

        const fileName = artifactLocationDraft.name.trim() || artifactDetail.originalFilename || deriveDisplayName(artifactDetail);
        const contentType = preview.state === "json"
            ? "application/json;charset=utf-8"
            : preview.state === "markdown"
                ? "text/markdown;charset=utf-8"
                : "text/plain;charset=utf-8";
        const file = new window.File([nextText], fileName, { type: contentType });
        const didReplace = await handleReplaceArtifact(file);
        if (didReplace) {
            setTextEditorDraft(nextText);
            setTextSourceText(nextText);
            setTextEditorError(null);
            setPreviewDialogTab("preview");
        }
    }

    function requestDeleteArtifact(artifactId: string) {
        setDeleteConfirm({
            type: "file",
            id: artifactId,
            title: t("confirm.deleteFileTitle"),
            description: t("confirm.deleteFileDescription"),
        });
    }

    async function deleteArtifact(artifactId: string) {
        try {
            const response = await fetch(`/api/ui/artifacts/${artifactId}/delete`, {
                method: "DELETE",
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.deleteFile")));
            }
            setSelectedEntry({ type: "folder", id: currentFolderId });
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success(t("toasts.fileDeleted"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.deleteFile"));
        }
    }

    function requestDeleteExternal(entry: DiscoveredStorageEntry) {
        setDeleteConfirm({
            type: "external",
            id: entry.logicalPath,
            entryType: entry.entryType,
            title: t("confirm.removeUntrackedTitle", { type: entry.entryType }),
            description: t("confirm.removeUntrackedDescription"),
        });
    }

    async function deleteExternal(logicalPath: string, entryType: "file" | "folder") {
        try {
            const response = await fetch("/api/ui/storage/discovered", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ logicalPath, entryType }),
            });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.removeUntracked")));
            }
            await reloadWorkspace(currentFolderId);
            toast.success(t("toasts.untrackedRemoved"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.removeUntracked"));
        }
    }

    async function handleConfirmDelete() {
        if (!deleteConfirm || isDeleting) return;
        setIsDeleting(true);
        try {
            if (deleteConfirm.type === "folder") {
                await deleteFolder(deleteConfirm.id);
            } else if (deleteConfirm.type === "external") {
                await deleteExternal(deleteConfirm.id, deleteConfirm.entryType || "file");
            } else {
                await deleteArtifact(deleteConfirm.id);
            }
            setDeleteConfirm(null);
        } finally {
            setIsDeleting(false);
        }
    }

    function handleDownloadArtifact(artifactId: string) {
        window.open(`/api/ui/artifacts/${artifactId}/download`, "_blank", "noopener,noreferrer");
    }

    function openArtifactEditor(artifactId: string) {
        window.location.assign(`/artifacts/${artifactId}/edit`);
    }

    function openFolder(folderId: string) {
        setCurrentFolderId(folderId);
        setSelectedEntry({ type: "folder", id: folderId });
        setExpandedFolders((current) => ({
            ...current,
            [folderId]: true,
        }));
    }

    function toggleFolder(folderId: string) {
        setExpandedFolders((current) => ({
            ...current,
            [folderId]: !current[folderId],
        }));
        if (!folderCache[folderId]) {
            void loadFolder(folderId);
        }
    }

    function beginCreateFolder() {
        const activeFolder = currentContents?.folder;
        setFolderDraft({
            name: "",
            parentFolderId: currentFolderId,
            projectId: activeFolder?.projectId ?? "",
            customerId: activeFolder?.customerId ?? "",
            metadataJson: "{}",
        });
        setIsCreateFolderOpen(true);
    }

    function beginCreateFolderAt(folder: Pick<FolderSummary, "id" | "projectId" | "customerId"> | null) {
        setFolderDraft({
            name: "",
            parentFolderId: folder?.id ?? ROOT_ID,
            projectId: folder?.projectId ?? "",
            customerId: folder?.customerId ?? "",
            metadataJson: "{}",
        });
        setIsCreateFolderOpen(true);
    }

    function renderFolderMenu(folder: FolderSummary | Pick<FolderSummary, "id" | "name" | "path" | "projectId" | "customerId">) {
        const isRootFolder = folder.id === ROOT_ID;
        return (
            <>
                {!isRootFolder && <ContextMenuItem onClick={() => openFolder(folder.id)}>{t("menu.open")}</ContextMenuItem>}
                <ContextMenuItem onClick={() => beginCreateFileAt(folder)}>{t("menu.newFileHere")}</ContextMenuItem>
                <ContextMenuItem onClick={() => {
                    setSelectedEntry({ type: "folder", id: folder.id });
                    beginCreateFolderAt({
                        id: folder.id,
                        projectId: folder.projectId ?? null,
                        customerId: folder.customerId ?? null,
                    });
                }}>
                    {t("menu.newFolderHere")}
                </ContextMenuItem>
                {!isRootFolder && (
                    <>
                        <ContextMenuItem onClick={() => {
                            setSelectedEntry({ type: "folder", id: folder.id });
                            setInspectorTab("properties");
                        }}>
                            {t("menu.editProperties")}
                        </ContextMenuItem>
                        <ContextMenuItem variant="destructive" onClick={() => requestDeleteFolder(folder.id)}>
                            {t("menu.deleteFolder")}
                        </ContextMenuItem>
                    </>
                )}
            </>
        );
    }

    function renderArtifactMenu(artifact: ArtifactSummary) {
        return (
            <>
                {canEditOfficeArtifact(artifact) && (
                    <ContextMenuItem onClick={() => openArtifactEditor(artifact.id)}>
                        {t("menu.editInEmperor")}
                    </ContextMenuItem>
                )}
                <ContextMenuItem onClick={() => {
                    setSelectedEntry({ type: "artifact", id: artifact.id });
                    setInspectorTab("preview");
                }}>
                    {t("menu.preview")}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleDownloadArtifact(artifact.id)}>{t("menu.download")}</ContextMenuItem>
                <ContextMenuItem onClick={() => beginRenameArtifact(artifact)}>{t("menu.rename")}</ContextMenuItem>
                <ContextMenuItem onClick={() => {
                    setSelectedEntry({ type: "artifact", id: artifact.id });
                    setInspectorTab("properties");
                }}>
                    {t("menu.editProperties")}
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" onClick={() => requestDeleteArtifact(artifact.id)}>
                    {t("menu.deleteFile")}
                </ContextMenuItem>
            </>
        );
    }

    function beginUpload() {
        const defaultProjectId = projectFilter || currentContents?.folder.projectId || "";
        const defaultCustomerId =
            currentContents?.folder.customerId ||
            customerFilter ||
            findProjectCustomerId(projects, defaultProjectId) ||
            "";
        setUploadProjectId(defaultProjectId);
        setUploadCustomerId(defaultProjectId ? findProjectCustomerId(projects, defaultProjectId) || defaultCustomerId : defaultCustomerId);
        setUploadTaskId("");
        setUploadTitle(uploadFile?.name ?? "");
        setIsUploadOpen(true);
    }

    function beginCreateFile() {
        beginCreateFileAt(currentContents?.folder ?? null);
    }

    function beginCreateFileAt(folder: Pick<FolderSummary, "id" | "projectId" | "customerId"> | null) {
        const folderId = folder?.id ?? ROOT_ID;
        const defaultProjectId = projectFilter || folder?.projectId || "";
        const defaultCustomerId =
            folder?.customerId ||
            customerFilter ||
            findProjectCustomerId(projects, defaultProjectId) ||
            "";
        setNewFileFolderId(folderId);
        setNewFileDraft({
            name: "untitled.csv",
            type: "csv",
            projectId: defaultProjectId,
            customerId: defaultProjectId ? findProjectCustomerId(projects, defaultProjectId) || defaultCustomerId : defaultCustomerId,
        });
        setIsNewFileOpen(true);
    }

    function beginRenameArtifact(artifact: ArtifactSummary) {
        const currentName = artifact.originalFilename || deriveDisplayName(artifact);
        const { baseName, extension } = splitFileNameExtension(currentName);
        setSelectedEntry({ type: "artifact", id: artifact.id });
        setRenameFileDraft({
            artifactId: artifact.id,
            baseName,
            extension,
            folderId: artifact.folderId ?? ROOT_ID,
        });
    }

    async function handleRenameFile() {
        if (!renameFileDraft) return;
        const baseName = renameFileDraft.baseName.trim();
        const nextName = `${baseName}${renameFileDraft.extension}`;
        if (!baseName || !isValidStorageFileName(nextName)) {
            toast.error(t("invalidFileName"));
            return;
        }

        setIsRenamingFile(true);
        try {
            const response = await fetch(`/api/ui/artifacts/${renameFileDraft.artifactId}/move`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    folderId: renameFileDraft.folderId === ROOT_ID ? null : renameFileDraft.folderId,
                    name: nextName,
                }),
            });
            if (!response.ok) throw new Error(await readError(response, t("errors.rename")));
            setRenameFileDraft(null);
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) await fetchSearchResults();
            toast.success(t("toasts.renamed", { name: nextName }));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.rename"));
        } finally {
            setIsRenamingFile(false);
        }
    }

    async function handleCreateFile() {
        const fileType = getCreatableFileType(newFileDraft.type);
        const fileName = ensureFileExtension(newFileDraft.name, fileType.extension);
        if (!isValidStorageFileName(fileName)) {
            toast.error(t("invalidFileName"));
            return;
        }

        setIsCreatingFile(true);
        try {
            const initialContent = await createInitialFileContent(fileType);
            const file = new window.File([initialContent], fileName, { type: fileType.contentType });
            const formData = new FormData();
            formData.set("file", file);
            formData.set("title", fileName);
            formData.set("kind", newFileDraft.type === "csv" || newFileDraft.type === "xlsx" ? "export" : "document");
            formData.set("artifactClass", DEFAULT_ARTIFACT_CLASS);
            formData.set("importance", DEFAULT_ARTIFACT_IMPORTANCE);
            formData.set("metadataJson", "{}");
            if (newFileDraft.projectId) formData.set("projectId", newFileDraft.projectId);
            if (newFileDraft.customerId) formData.set("customerId", newFileDraft.customerId);
            if (newFileFolderId !== ROOT_ID) formData.set("folderId", newFileFolderId);

            const response = await fetch("/api/ui/artifacts/upload", { method: "POST", body: formData });
            if (!response.ok) {
                throw new Error(await readError(response, t("errors.createFile")));
            }
            const payload = await response.json() as { artifact: ArtifactSummary };
            setIsNewFileOpen(false);
            if (fileType.editor === "office") {
                toast.success(t("toasts.created", { name: fileName }));
                router.push(`/artifacts/${payload.artifact.id}/edit`);
                return;
            }
            pendingEditorTabRef.current = fileType.editor === "csv" ? "table" : "edit";
            setPreview({ state: "loading" });
            setSelectedEntry({ type: "artifact", id: payload.artifact.id });
            setInspectorTab("preview");
            setIsPreviewDialogOpen(true);
            await reloadWorkspace(newFileFolderId);
            toast.success(t("toasts.created", { name: fileName }));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.createFile"));
        } finally {
            setIsCreatingFile(false);
        }
    }

    function handleReplaceInput(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }
        void handleReplaceArtifact(file);
        event.target.value = "";
    }

    function handleUploadFileChange(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0] ?? null;
        setUploadFile(file);
        if (file) {
            setUploadTitle(file.name);
        }
    }

    function beginTrackExternal(entry: DiscoveredStorageEntry) {
        if (entry.entryType !== "file") {
            toast.info(t("createFolderFirst"));
            return;
        }
        setExternalToTrack(entry);
        setUploadTitle(entry.name);
        setUploadKind("document");
        setUploadArtifactClass(DEFAULT_ARTIFACT_CLASS);
        setUploadImportance(DEFAULT_ARTIFACT_IMPORTANCE);
        setUploadProjectId("");
        setUploadTaskId("");
        setUploadCustomerId("");
        setUploadMetadataJson("{}");
    }

    async function handleTrackExternal() {
        if (!externalToTrack) return;
        if (!uploadProjectId && !uploadCustomerId) {
            toast.error(t("selectScopeFirst"));
            return;
        }
        setIsUploading(true);
        try {
            const response = await fetch("/api/ui/artifacts/finalize", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    logicalPath: externalToTrack.logicalPath,
                    filename: externalToTrack.name,
                    title: uploadTitle || externalToTrack.name,
                    kind: uploadKind,
                    contentType: externalToTrack.contentType || "application/octet-stream",
                    folderId: currentFolderId === ROOT_ID ? null : currentFolderId,
                    projectId: uploadProjectId || null,
                    taskId: uploadTaskId || null,
                    customerId: uploadCustomerId || null,
                    artifactClass: uploadArtifactClass,
                    importance: uploadImportance,
                    metadataJson: parseJsonInput(uploadMetadataJson),
                }),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || t("errors.track"));
            setExternalToTrack(null);
            await reloadWorkspace(currentFolderId);
            toast.success(t("toasts.tracked"));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("errors.track"));
        } finally {
            setIsUploading(false);
        }
    }

    function clearFilters() {
        setSearchValue("");
        setProjectFilter("");
        setTaskFilter("");
        setCustomerFilter("");
        setKindFilter("");
    }

    const breadcrumbItems = currentContents
        ? [{ id: ROOT_ID, name: t("root"), path: "" }, ...currentContents.ancestors, currentContents.folder.id === ROOT_ID ? null : currentContents.folder].filter(Boolean) as Array<Pick<FolderSummary, "id" | "name" | "path">>
        : [{ id: ROOT_ID, name: t("root"), path: "" }];

    return (
        <div className="mx-auto flex h-full max-w-[1800px] flex-col gap-6">
            <div className="space-y-2">
                <PageHeader
                    eyebrow={t("eyebrow")}
                    title={t("eyebrow")}
                    description={t("description")}
                    actions={
                        <>
                            <Button variant="outline" onClick={() => void reloadWorkspace()} className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900">
                                <IconRefresh className="size-4" />
                                {t("refresh")}
                            </Button>
                            <Button variant="outline" onClick={beginCreateFolder} className="cursor-pointer border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900">
                                <IconFolderPlus className="size-4" />
                                {t("newFolder")}
                            </Button>
                            <Button variant="outline" onClick={beginCreateFile} className="cursor-pointer border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900">
                                <IconFilePlus className="size-4" />
                                {t("newFile")}
                            </Button>
                            <Button onClick={beginUpload} className="cursor-pointer bg-zinc-100 text-zinc-950 hover:bg-zinc-200">
                                <IconUpload className="size-4" />
                                {t("upload")}
                            </Button>
                        </>
                    }
                />
                <div className="grid gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-950/80 px-4 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
                    <div className="relative min-w-[240px] flex-1">
                        <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                        <Input
                            value={searchValue}
                            onChange={(event) => setSearchValue(event.target.value)}
                            placeholder={t("searchPlaceholder")}
                            className="border-zinc-800 bg-zinc-900 pl-9 text-zinc-100"
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <select
                            value={customerFilter}
                            onChange={(event) => {
                                const nextCustomerId = event.target.value;
                                setCustomerFilter(nextCustomerId);
                                if (
                                    projectFilter &&
                                    nextCustomerId &&
                                    findProjectCustomerId(projects, projectFilter) !== nextCustomerId
                                ) {
                                    setProjectFilter("");
                                    setTaskFilter("");
                                }
                            }}
                            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200 sm:w-auto"
                        >
                            <option value="">{t("allCustomers")}</option>
                            {customers.map((customer) => (
                                <option key={customer.id} value={customer.id}>{customer.name}</option>
                            ))}
                        </select>
                        <select
                            value={projectFilter}
                            onChange={(event) => {
                                const nextProjectId = event.target.value;
                                setProjectFilter(nextProjectId);
                                const nextProjectCustomerId = findProjectCustomerId(projects, nextProjectId);
                                if (nextProjectId && nextProjectCustomerId && customerFilter !== nextProjectCustomerId) {
                                    setCustomerFilter(nextProjectCustomerId);
                                }
                                if (taskFilter && !tasks.some((task) => task.id === taskFilter && task.projectId === nextProjectId)) {
                                    setTaskFilter("");
                                }
                            }}
                            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200 sm:w-auto"
                        >
                            <option value="">{t("allProjects")}</option>
                            {projects.map((project) => (
                                <option key={project.id} value={project.id}>{project.name}</option>
                            ))}
                        </select>
                        {hasActiveFilters && (
                            <Button
                                variant="outline"
                                onClick={clearFilters}
                                className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                            >
                                {t("clear")}
                            </Button>
                        )}
                    </div>
                    <details className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 px-3 py-2">
                        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                            {t("advancedFilters")}
                        </summary>
                        <div className="mt-3 flex flex-wrap gap-3 border-t border-zinc-800/80 pt-3">
                            <select
                                value={taskFilter}
                                onChange={(event) => setTaskFilter(event.target.value)}
                                className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="">{t("allTasks")}</option>
                                {tasks.filter((task) => !projectFilter || task.projectId === projectFilter).map((task) => (
                                    <option key={task.id} value={task.id}>{task.type}</option>
                                ))}
                            </select>
                            <select
                                value={kindFilter}
                                onChange={(event) => setKindFilter(event.target.value)}
                                className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="">{t("allFileTypes")}</option>
                                {ARTIFACT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`kinds.${kind}`)}</option>)}
                            </select>
                        </div>
                    </details>
                </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                <Card className="min-h-0 border-zinc-800/80 bg-zinc-950/70 py-0">
                    <CardHeader className="border-b border-zinc-800/80 py-4">
                        <CardTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">{t("folders")}</CardTitle>
                    </CardHeader>
                    <CardContent className="min-h-0 px-0">
                        {/* Phones stack the tree above the files: cap it so the files stay in reach. */}
                        <ScrollArea className="h-64 lg:h-[calc(100vh-18rem)]">
                            <div className="space-y-1 px-3 py-3">
                                <TreeFolderRow
                                    folder={{ id: ROOT_ID, name: t("root"), path: "", projectId: null, customerId: null }}
                                    depth={0}
                                    isExpanded={expandedFolders[ROOT_ID] ?? true}
                                    isSelected={selectedEntry?.type === "folder" && selectedEntry.id === ROOT_ID}
                                    onToggle={() => toggleFolder(ROOT_ID)}
                                    onOpen={() => openFolder(ROOT_ID)}
                                    onContextMenu={() => setSelectedEntry({ type: "folder", id: ROOT_ID })}
                                    contextMenuContent={renderFolderMenu({ id: ROOT_ID, name: t("root"), path: "", projectId: null, customerId: null })}
                                />
                                {(folderCache[ROOT_ID]?.folders ?? []).map((folder) => (
                                    <FolderTreeBranch
                                        key={folder.id}
                                        folder={folder}
                                        depth={1}
                                        cache={folderCache}
                                        expandedFolders={expandedFolders}
                                        selectedEntry={selectedEntry}
                                        onToggle={toggleFolder}
                                        onOpen={openFolder}
                                        onContextMenu={(folderId) => setSelectedEntry({ type: "folder", id: folderId })}
                                        renderFolderContextMenu={(folder) => renderFolderMenu(folder)}
                                    />
                                ))}
                            </div>
                        </ScrollArea>
                    </CardContent>
                </Card>

                <Card className="min-h-0 border-zinc-800/80 bg-zinc-950/70 py-0">
                    <CardHeader className="border-b border-zinc-800/80 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-1 text-sm text-zinc-400">
                                    {breadcrumbItems.map((item, index) => (
                                        <div key={item.id} className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={() => openFolder(item.id)}
                                                className="rounded px-1 py-0.5 text-left transition hover:bg-zinc-900 hover:text-zinc-100"
                                            >
                                                {item.name}
                                            </button>
                                            {index < breadcrumbItems.length - 1 && <IconChevronRight className="size-3 text-zinc-600" />}
                                        </div>
                                    ))}
                                </div>
                                <CardTitle className="text-xl text-zinc-100">
                                    {isSearchMode ? t("searchResults") : currentContents?.folder.name || t("root")}
                                </CardTitle>
                            </div>
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                                    {t("badges.folders", { count: visibleFolders.length })}
                                </Badge>
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                                    {t("badges.tracked", { count: visibleArtifacts.length })}
                                </Badge>
                                {visibleDiscoveredEntries.length > 0 && (
                                    <Badge variant="outline" className="border-amber-500/40 text-amber-200">
                                        {t("badges.needsMetadata", { count: visibleDiscoveredEntries.length })}
                                    </Badge>
                                )}
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="min-h-0 px-0">
                        <div className={cn(BROWSER_GRID, "border-b border-zinc-800/80 px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500")}>
                            <span>{t("columns.name")}</span>
                            <span className="hidden md:block">{t("columns.context")}</span>
                            <span className="hidden md:block">{t("columns.size")}</span>
                            <span className="hidden md:block">{t("columns.updated")}</span>
                            <span />
                        </div>
                        <ScrollArea className="h-[calc(100vh-18rem)]">
                            <div className="px-2 py-2">
                                {!isSearchMode && visibleFolders.map((folder) => (
                                    <BrowserRow
                                        key={folder.id}
                                        icon={<IconFolder className="size-4 text-amber-300" />}
                                        title={folder.name}
                                        subtitle={folder.path || t("root")}
                                        context={folder.projectId ? projects.find((project) => project.id === folder.projectId)?.name || t("scopedFolder") : t("folder")}
                                        sizeLabel={t("folder")}
                                        dateLabel={formatDate(folder.createdAt)}
                                        selected={selectedEntry?.type === "folder" && selectedEntry.id === folder.id}
                                        onClick={() => setSelectedEntry({ type: "folder", id: folder.id })}
                                        onDoubleClick={() => openFolder(folder.id)}
                                        onInspect={() => { setSelectedEntry({ type: "folder", id: folder.id }); setInspectorTab("properties"); setIsInspectorOpen(true); }}
                                        onContextMenu={() => setSelectedEntry({ type: "folder", id: folder.id })}
                                        contextMenuContent={renderFolderMenu(folder)}
                                        actions={(
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon-sm" className="text-zinc-400 hover:text-zinc-100">
                                                        <IconDots className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                                                    <DropdownMenuItem onClick={() => openFolder(folder.id)}>{t("menu.open")}</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => {
                                                        setSelectedEntry({ type: "folder", id: folder.id });
                                                        beginCreateFileAt(folder);
                                                    }}>{t("menu.newFileHere")}</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => {
                                                        setSelectedEntry({ type: "folder", id: folder.id });
                                                        beginCreateFolderAt(folder);
                                                    }}>{t("menu.newFolderHere")}</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "folder", id: folder.id }); setInspectorTab("properties"); setIsInspectorOpen(true); }}>{t("menu.editProperties")}</DropdownMenuItem>
                                                    <DropdownMenuItem variant="destructive" onClick={() => requestDeleteFolder(folder.id)}>{t("menu.deleteFolder")}</DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        )}
                                    />
                                ))}
                                {visibleArtifacts.map((artifact) => (
                                    <BrowserRow
                                        key={artifact.id}
                                        icon={renderArtifactIcon(artifact)}
                                        title={deriveDisplayName(artifact)}
                                        subtitle={artifact.path || artifact.originalFilename || artifact.kind}
                                        context={buildArtifactContextLabel(artifact)}
                                        sizeLabel={formatBytes(artifact.sizeBytes)}
                                        dateLabel={formatDate(artifact.updatedAt || artifact.createdAt)}
                                        selected={selectedEntry?.type === "artifact" && selectedEntry.id === artifact.id}
                                        onClick={() => setSelectedEntry({ type: "artifact", id: artifact.id })}
                                        onDoubleClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("preview"); setIsInspectorOpen(true); }}
                                        onInspect={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("preview"); setIsInspectorOpen(true); }}
                                        onContextMenu={() => setSelectedEntry({ type: "artifact", id: artifact.id })}
                                        contextMenuContent={renderArtifactMenu(artifact)}
                                        actions={(
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon-sm" className="text-zinc-400 hover:text-zinc-100">
                                                        <IconDots className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                                                    {canEditOfficeArtifact(artifact) && <DropdownMenuItem onClick={() => openArtifactEditor(artifact.id)}>{t("menu.editInEmperor")}</DropdownMenuItem>}
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("preview"); setIsInspectorOpen(true); }}>{t("menu.preview")}</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => handleDownloadArtifact(artifact.id)}>{t("menu.download")}</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => beginRenameArtifact(artifact)}>{t("menu.rename")}</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("properties"); setIsInspectorOpen(true); }}>{t("menu.editProperties")}</DropdownMenuItem>
                                                    <DropdownMenuItem variant="destructive" onClick={() => requestDeleteArtifact(artifact.id)}>{t("menu.deleteFile")}</DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        )}
                                    />
                                ))}
                                {visibleDiscoveredEntries.map((entry) => (
                                    <BrowserRow
                                        key={`external-${entry.logicalPath}`}
                                        icon={entry.entryType === "folder"
                                            ? <IconFolder className="size-4 text-amber-300" />
                                            : <span className="flex size-5 items-center justify-center rounded-full border border-amber-400/50 bg-amber-400/10"><IconQuestionMark className="size-3 text-amber-200" /></span>}
                                        title={entry.name}
                                        subtitle={entry.logicalPath}
                                        context={entry.entryType === "folder" ? t("externalFolder") : t("missingMetadata")}
                                        sizeLabel={entry.sizeBytes === null ? t("folder") : formatBytes(entry.sizeBytes)}
                                        dateLabel={formatDate(entry.modifiedAt)}
                                        selected={false}
                                        onClick={() => beginTrackExternal(entry)}
                                        onDoubleClick={() => beginTrackExternal(entry)}
                                        onInspect={() => beginTrackExternal(entry)}
                                        contextMenuContent={(
                                            <>
                                                {entry.entryType === "file" && <ContextMenuItem onClick={() => beginTrackExternal(entry)}>{t("menu.addMetadata")}</ContextMenuItem>}
                                                <ContextMenuItem variant="destructive" onClick={() => requestDeleteExternal(entry)}>{t("menu.removeExternal")}</ContextMenuItem>
                                            </>
                                        )}
                                        actions={(
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon-sm" aria-label={t("actionsFor", { name: entry.name })} className="text-amber-100 hover:bg-amber-500/10 hover:text-amber-50">
                                                        <IconDots className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-56 border-zinc-800 bg-zinc-950 text-zinc-100">
                                                    {entry.entryType === "file" && <DropdownMenuItem onClick={() => beginTrackExternal(entry)}><IconPlus className="size-4" />{t("menu.addMetadata")}</DropdownMenuItem>}
                                                    <DropdownMenuItem variant="destructive" onClick={() => requestDeleteExternal(entry)}><IconTrash className="size-4" />{t("menu.removeExternal")}</DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        )}
                                    />
                                ))}
                                {loadingFolderId === currentFolderId && !isSearchMode && (
                                    <div className="flex items-center gap-2 px-4 py-6 text-sm text-zinc-400">
                                        <IconLoader2 className="size-4 animate-spin" />
                                        {t("loadingFolder")}
                                    </div>
                                )}
                                {isSearchLoading && isSearchMode && (
                                    <div className="flex items-center gap-2 px-4 py-6 text-sm text-zinc-400">
                                        <IconLoader2 className="size-4 animate-spin" />
                                        {t("searching")}
                                    </div>
                                )}
                                {!loadingFolderId && !isSearchLoading && visibleFolders.length === 0 && visibleArtifacts.length === 0 && visibleDiscoveredEntries.length === 0 && (
                                    <EmptyState
                                        className="mx-2 mt-2"
                                        icon={isSearchMode ? IconSearch : IconFolderOpen}
                                        title={isSearchMode ? t("empty.searchTitle") : currentFolderId === ROOT_ID ? t("empty.rootTitle") : t("empty.folderTitle")}
                                        description={isSearchMode
                                            ? t("empty.searchDescription")
                                            : currentFolderId === ROOT_ID
                                                ? t("empty.rootDescription")
                                                : t("empty.folderDescription")}
                                        action={hasActiveFilters ? <Button type="button" variant="outline" size="sm" onClick={clearFilters}>{t("clearFilters")}</Button> : undefined}
                                    />
                                )}
                            </div>
                        </ScrollArea>
                    </CardContent>
                </Card>
                {/* Inspector is now a dialog */}
            </div>

            <FolderDialog
                open={isCreateFolderOpen}
                draft={folderDraft}
                projects={projects}
                customers={customers}
                isSaving={isSavingFolder}
                onOpenChange={setIsCreateFolderOpen}
                onDraftChange={setFolderDraft}
                onSubmit={() => void handleCreateFolder()}
            />

            <NewFileDialog
                open={isNewFileOpen}
                draft={newFileDraft}
                projects={projects}
                customers={customers}
                isCreating={isCreatingFile}
                onOpenChange={setIsNewFileOpen}
                onDraftChange={setNewFileDraft}
                onSubmit={() => void handleCreateFile()}
            />

            <RenameFileDialog
                draft={renameFileDraft}
                isRenaming={isRenamingFile}
                onDraftChange={setRenameFileDraft}
                onOpenChange={(open) => { if (!open && !isRenamingFile) setRenameFileDraft(null); }}
                onSubmit={() => void handleRenameFile()}
            />

            <UploadDialog
                open={isUploadOpen}
                uploadFile={uploadFile}
                uploadTitle={uploadTitle}
                uploadKind={uploadKind}
                uploadArtifactClass={uploadArtifactClass}
                uploadImportance={uploadImportance}
                uploadProjectId={uploadProjectId}
                uploadTaskId={uploadTaskId}
                uploadCustomerId={uploadCustomerId}
                uploadMetadataJson={uploadMetadataJson}
                projects={projects}
                tasks={availableTasks}
                customers={customers}
                isUploading={isUploading}
                onOpenChange={setIsUploadOpen}
                onFileChange={handleUploadFileChange}
                onTitleChange={setUploadTitle}
                onKindChange={setUploadKind}
                onArtifactClassChange={setUploadArtifactClass}
                onImportanceChange={setUploadImportance}
                onProjectChange={(nextProjectId) => {
                    setUploadProjectId(nextProjectId);
                    setUploadCustomerId(findProjectCustomerId(projects, nextProjectId) || "");
                    setUploadTaskId("");
                }}
                onCustomerChange={setUploadCustomerId}
                onMetadataJsonChange={setUploadMetadataJson}
                onSubmit={() => void handleUpload()}
            />

            <TrackExternalDialog
                entry={externalToTrack}
                title={uploadTitle}
                kind={uploadKind}
                artifactClass={uploadArtifactClass}
                importance={uploadImportance}
                projectId={uploadProjectId}
                customerId={uploadCustomerId}
                metadataJson={uploadMetadataJson}
                projects={projects}
                customers={customers}
                isSaving={isUploading}
                onOpenChange={(open) => { if (!open && !isUploading) setExternalToTrack(null); }}
                onTitleChange={setUploadTitle}
                onKindChange={setUploadKind}
                onArtifactClassChange={setUploadArtifactClass}
                onImportanceChange={setUploadImportance}
                onProjectChange={(value) => {
                    setUploadProjectId(value);
                    setUploadCustomerId(findProjectCustomerId(projects, value) || "");
                }}
                onCustomerChange={setUploadCustomerId}
                onMetadataJsonChange={setUploadMetadataJson}
                onSubmit={() => void handleTrackExternal()}
            />

            <PreviewDialog
                open={isPreviewDialogOpen}
                onOpenChange={setIsPreviewDialogOpen}
                artifact={artifactDetail}
                preview={preview}
                activeTab={previewDialogTab}
                onTabChange={setPreviewDialogTab}
                csvRows={csvEditorRows}
                csvRawDraft={csvRawDraft}
                csvRawError={csvRawError}
                isSavingCsv={isSavingArtifact}
                isCsvDirty={isCsvDirty}
                textDraft={textEditorDraft}
                textError={textEditorError}
                isTextDirty={isTextDirty}
                onCsvCellChange={handleCsvCellChange}
                onAddCsvRow={handleAddCsvRow}
                onDeleteCsvRow={handleDeleteCsvRow}
                onAddCsvColumn={handleAddCsvColumn}
                onDeleteCsvColumn={handleDeleteCsvColumn}
                onCsvRawDraftChange={(value) => {
                    setCsvRawDraft(value);
                    setCsvRawError(null);
                }}
                onApplyRawCsvToGrid={handleApplyRawCsvToGrid}
                onResetCsvDraft={handleResetCsvDraft}
                onSaveCsvDraft={() => void handleSaveCsvDraft()}
                onTextDraftChange={(value) => {
                    setTextEditorDraft(value);
                    setTextEditorError(null);
                }}
                onResetTextDraft={() => {
                    setTextEditorDraft(textSourceText);
                    setTextEditorError(null);
                }}
                onSaveTextDraft={() => void handleSaveTextDraft()}
            />

            <Dialog open={isInspectorOpen} onOpenChange={setIsInspectorOpen}>
                <DialogContent className="max-h-[92vh] w-[95vw] overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-4xl lg:max-w-6xl xl:max-w-[1200px]">
                    <div className="flex h-[85vh] min-h-[500px] flex-col">
                        <DialogHeader className="flex flex-row items-center justify-between border-b border-zinc-800 px-6 py-4 pr-14">
                            <DialogTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">{t("inspector")}</DialogTitle>
                            {selectedEntry?.type === "artifact" && (
                                <Button variant="ghost" size="icon-sm" onClick={() => setInspectorTab(inspectorTab === "preview" ? "properties" : "preview")} className="text-zinc-400 hover:text-zinc-100 mt-0!">
                                    <IconSettings className="size-4" />
                                </Button>
                            )}
                        </DialogHeader>
                        <div className="min-h-0 flex-1 overflow-auto bg-zinc-950/50">
                            <div className="p-6">
                                {!selectedEntry && <EmptyInspector />}
                                {selectedEntry?.type === "folder" && selectedFolder && (
                                    <FolderInspector
                                        folder={selectedFolder}
                                        draft={folderDraft}
                                        knownFolders={knownFolders}
                                        projects={projects}
                                        customers={customers}
                                        isSaving={isSavingFolder}
                                        hasChanges={hasFolderChanges}
                                        onDraftChange={setFolderDraft}
                                        onSave={() => void handleSaveFolder()}
                                        onDelete={() => requestDeleteFolder(selectedFolder.id)}
                                    />
                                )}
                                {selectedEntry?.type === "artifact" && artifactDetail && (
                                    <ArtifactInspector
                                        artifact={artifactDetail}
                                        draft={artifactDraft}
                                        locationDraft={artifactLocationDraft}
                                        knownFolders={knownFolders}
                                        projects={projects}
                                        tasks={tasks}
                                        customers={customers}
                                        preview={preview}
                                        inspectorTab={inspectorTab}
                                        isSavingArtifact={isSavingArtifact}
                                        isSavingLocation={isSavingLocation}
                                        hasPropertyChanges={hasArtifactPropertyChanges}
                                        hasLocationChanges={hasArtifactLocationChanges}
                                        onInspectorTabChange={setInspectorTab}
                                        onDraftChange={setArtifactDraft}
                                        onLocationDraftChange={setArtifactLocationDraft}
                                        onSaveProperties={() => void handleSaveArtifactProperties()}
                                        onSaveLocation={() => void handleSaveArtifactLocation()}
                                        onReplace={() => replaceInputRef.current?.click()}
                                        onEdit={canEditOfficeArtifact(artifactDetail) ? () => openArtifactEditor(artifactDetail.id) : undefined}
                                        onDownload={() => handleDownloadArtifact(artifactDetail.id)}
                                        onDelete={() => requestDeleteArtifact(artifactDetail.id)}
                                        onOpenLargePreview={() => {
                                            setPreviewDialogTab("preview");
                                            setIsPreviewDialogOpen(true);
                                        }}
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(deleteConfirm)} onOpenChange={(open) => {
                if (!open && !isDeleting) setDeleteConfirm(null);
            }}>
                <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{deleteConfirm?.title || t("confirm.deleteItem")}</DialogTitle>
                        <DialogDescription className="text-zinc-400">
                            {deleteConfirm?.description || t("confirm.deleteItemDescription")}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteConfirm(null)} disabled={isDeleting} className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900">
                            {t("cancel")}
                        </Button>
                        <Button onClick={() => void handleConfirmDelete()} disabled={isDeleting} className="bg-rose-500 text-white hover:bg-rose-400">
                            {isDeleting ? t("deleting") : t("delete")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <input ref={replaceInputRef} type="file" className="hidden" onChange={handleReplaceInput} />
        </div>
    );
}

function FolderTreeBranch(props: {
    folder: FolderSummary;
    depth: number;
    cache: Record<string, FolderContentsResponse>;
    expandedFolders: Record<string, boolean>;
    selectedEntry: SelectedEntry;
    onToggle: (folderId: string) => void;
    onOpen: (folderId: string) => void;
    onContextMenu: (folderId: string) => void;
    renderFolderContextMenu: (folder: FolderSummary) => ReactNode;
}) {
    const { folder, depth, cache, expandedFolders, selectedEntry, onToggle, onOpen } = props;
    const isExpanded = expandedFolders[folder.id] ?? false;
    const children = cache[folder.id]?.folders ?? [];

    return (
        <div>
            <TreeFolderRow
                folder={folder}
                depth={depth}
                isExpanded={isExpanded}
                isSelected={selectedEntry?.type === "folder" && selectedEntry.id === folder.id}
                onToggle={() => onToggle(folder.id)}
                onOpen={() => onOpen(folder.id)}
                onContextMenu={() => props.onContextMenu(folder.id)}
                contextMenuContent={props.renderFolderContextMenu(folder)}
            />
            {isExpanded && children.map((child) => (
                <FolderTreeBranch
                    key={child.id}
                    folder={child}
                    depth={depth + 1}
                    cache={cache}
                    expandedFolders={expandedFolders}
                    selectedEntry={selectedEntry}
                    onToggle={onToggle}
                    onOpen={onOpen}
                    onContextMenu={props.onContextMenu}
                    renderFolderContextMenu={props.renderFolderContextMenu}
                />
            ))}
        </div>
    );
}

function TreeFolderRow(props: {
    folder: Pick<FolderSummary, "id" | "name" | "path" | "projectId" | "customerId">;
    depth: number;
    isExpanded: boolean;
    isSelected: boolean;
    onToggle: () => void;
    onOpen: () => void;
    onContextMenu?: () => void;
    contextMenuContent?: ReactNode;
}) {
    const row = (
        <button
            type="button"
            onClick={props.onOpen}
            onContextMenu={props.onContextMenu}
            className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition overflow-hidden",
                props.isSelected ? "bg-zinc-900 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-100"
            )}
            style={{ paddingLeft: `${props.depth * 14 + 8}px` }}
        >
            <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                    event.stopPropagation();
                    props.onToggle();
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        props.onToggle();
                    }
                }}
                className="flex size-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800"
            >
                {props.isExpanded ? <IconChevronDown className="size-3.5" /> : <IconChevronRight className="size-3.5" />}
            </span>
            <IconFolder className="size-4 shrink-0 text-amber-300" />
            <span className="truncate flex-1 min-w-0">{props.folder.name}</span>
        </button>
    );

    if (!props.contextMenuContent) {
        return row;
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                {props.contextMenuContent}
            </ContextMenuContent>
        </ContextMenu>
    );
}

function BrowserRow(props: {
    icon: ReactNode;
    title: string;
    subtitle: string;
    context: string;
    sizeLabel: string;
    dateLabel: string;
    selected: boolean;
    onClick: () => void;
    onDoubleClick: () => void;
    onInspect?: () => void;
    onContextMenu?: () => void;
    contextMenuContent?: ReactNode;
    actions: ReactNode;
}) {
    const row = (
        <div
            onClick={props.onClick}
            onDoubleClick={props.onDoubleClick}
            onContextMenu={props.onContextMenu}
            className={cn(
                BROWSER_GRID, "cursor-default items-center rounded-xl px-2 py-1.5 transition",
                props.selected ? "bg-zinc-900" : "hover:bg-zinc-900/70"
            )}
        >
            <div className="flex min-w-0 items-center gap-3 px-2 py-2">
                <div className="flex size-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950">{props.icon}</div>
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-100">{props.title}</div>
                    <div className="truncate text-xs text-zinc-500">{props.subtitle}</div>
                </div>
            </div>
            <div className="hidden truncate px-2 text-sm text-zinc-400 md:block">{props.context}</div>
            <div className="hidden px-2 text-sm text-zinc-400 md:block">{props.sizeLabel}</div>
            <div className="hidden px-2 text-sm text-zinc-400 md:block">{props.dateLabel}</div>
            <div className="flex items-center justify-end">
                {props.onInspect && (
                    <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); props.onInspect?.(); }} className="text-zinc-400 hover:text-zinc-100">
                        <IconArrowsMaximize className="size-4" />
                    </Button>
                )}
                {props.actions}
            </div>
        </div>
    );

    if (!props.contextMenuContent) {
        return row;
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                {props.contextMenuContent}
            </ContextMenuContent>
        </ContextMenu>
    );
}

function FolderInspector(props: {
    folder: FolderSummary;
    draft: FolderDraft;
    knownFolders: Array<{ id: string; pathLabel: string }>;
    projects: ProjectOption[];
    customers: CustomerOption[];
    isSaving: boolean;
    hasChanges: boolean;
    onDraftChange: Dispatch<SetStateAction<FolderDraft>>;
    onSave: () => void;
    onDelete: () => void;
}) {
    const t = useTranslations("artifacts");
    if (props.folder.id === ROOT_ID) {
        return (
            <div className="space-y-4">
                <div className="flex items-start gap-3">
                    <div className="flex size-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                        <IconFolder className="size-6 text-amber-300" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-zinc-100">{t("root")}</h2>
                        <p className="text-sm text-zinc-400">{t("folderInspector.rootSubtitle")}</p>
                    </div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 text-sm text-zinc-400">
                    {t("folderInspector.rootBody")}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <div className="flex items-start gap-3">
                <div className="flex size-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                    <IconFolder className="size-6 text-amber-300" />
                </div>
                <div>
                    <h2 className="text-lg font-semibold text-zinc-100">{props.folder.name}</h2>
                    <p className="text-sm text-zinc-400">{props.folder.path || t("folderInspector.rootFolder")}</p>
                </div>
            </div>
            <div className="space-y-4">
                <Field label={t("fields.folderName")}>
                    <Input
                        value={props.draft.name}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, name: event.target.value }))}
                        className="border-zinc-800 bg-zinc-900 text-zinc-100"
                    />
                </Field>
                <Field label={t("fields.parentFolder")}>
                    <select
                        value={props.draft.parentFolderId}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, parentFolderId: event.target.value }))}
                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        {props.knownFolders.filter((folder) => folder.id !== props.folder.id).map((folder) => (
                            <option key={folder.id} value={folder.id}>{folder.pathLabel}</option>
                        ))}
                    </select>
                </Field>
                <Field label={t("fields.project")}>
                    <select
                        value={props.draft.projectId}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, projectId: event.target.value }))}
                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">{t("fields.none")}</option>
                        {props.projects.map((project) => (
                            <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                    </select>
                </Field>
                <Field label={t("fields.customer")}>
                    <select
                        value={props.draft.customerId}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, customerId: event.target.value }))}
                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">{t("fields.none")}</option>
                        {props.customers.map((customer) => (
                            <option key={customer.id} value={customer.id}>{customer.name}</option>
                        ))}
                    </select>
                </Field>
                <details className="rounded-2xl border border-zinc-800 bg-zinc-950/80">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-300">{t("folderMetadata.title")}</summary>
                    <div className="border-t border-zinc-800 px-4 py-4">
                        <p className="mb-3 text-xs leading-5 text-zinc-500">{t("folderMetadata.inspectorHint")}</p>
                        <Field label={t("fields.metadataJson")}>
                            <Textarea
                                value={props.draft.metadataJson}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, metadataJson: event.target.value }))}
                                className="min-h-36 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100"
                            />
                        </Field>
                    </div>
                </details>
                <div className="flex flex-wrap gap-2">
                    <Button onClick={props.onSave} disabled={props.isSaving || !props.hasChanges}>
                        {props.isSaving && <IconLoader2 className="size-4 animate-spin" />}
                        {t("folderInspector.save")}
                    </Button>
                    <Button variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20" onClick={props.onDelete}>
                        <IconTrash className="size-4" />
                        {t("delete")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function ArtifactInspector(props: {
    artifact: ArtifactDetail;
    draft: ArtifactDraft;
    locationDraft: ArtifactLocationDraft;
    knownFolders: Array<{ id: string; pathLabel: string }>;
    projects: ProjectOption[];
    tasks: TaskOption[];
    customers: CustomerOption[];
    preview: PreviewState;
    inspectorTab: string;
    isSavingArtifact: boolean;
    isSavingLocation: boolean;
    hasPropertyChanges: boolean;
    hasLocationChanges: boolean;
    onInspectorTabChange: (value: string) => void;
    onDraftChange: Dispatch<SetStateAction<ArtifactDraft>>;
    onLocationDraftChange: Dispatch<SetStateAction<ArtifactLocationDraft>>;
    onSaveProperties: () => void;
    onSaveLocation: () => void;
    onReplace: () => void;
    onEdit?: () => void;
    onDownload: () => void;
    onDelete: () => void;
    onOpenLargePreview: () => void;
}) {
    const t = useTranslations("artifacts");
    const taxonomy = useArtifactTaxonomy();
    const formatDate = useRelativeDate();
    return (
        <Tabs value={props.inspectorTab} onValueChange={props.onInspectorTabChange}>
            <TabsList variant="line" className="mb-4 border-b border-zinc-800 pb-1">
                <TabsTrigger value="preview">{t("tabs.preview")}</TabsTrigger>
                <TabsTrigger value="properties">{t("tabs.properties")}</TabsTrigger>
            </TabsList>
            <TabsContent value="preview">
                <div className="space-y-4">
                    <div className="flex items-start gap-3">
                        <div className="flex size-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                            {renderArtifactIcon(props.artifact)}
                        </div>
                        <div className="min-w-0">
                            <h2 className="truncate text-lg font-semibold text-zinc-100">{deriveDisplayName(props.artifact)}</h2>
                            <p className="truncate text-sm text-zinc-400">{props.artifact.path || props.artifact.originalFilename || props.artifact.kind}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">{props.artifact.kind}</Badge>
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">{taxonomy.classLabel(props.artifact.artifactClass)}</Badge>
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">{taxonomy.importanceLabel(props.artifact.importance)}</Badge>
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">{props.artifact.contentType}</Badge>
                                {props.artifact.isCanonical && <Badge className="bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/15">{t("canonicalBadge")}</Badge>}
                            </div>
                        </div>
                    </div>
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4">
                        <PreviewPanel preview={props.preview} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {props.onEdit && (
                            <Button className="bg-cyan-300 text-zinc-950 hover:bg-cyan-200" onClick={props.onEdit}>
                                <IconPencil className="size-4" />
                                {t("menu.editInEmperor")}
                            </Button>
                        )}
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onDownload}>
                            <IconArrowDown className="size-4" />
                            {t("menu.download")}
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onOpenLargePreview}>
                            <IconArrowsMaximize className="size-4" />
                            {props.preview.state === "csv" ? t("inspectorView.openCsv") : t("inspectorView.openLarge")}
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onReplace}>
                            <IconPencil className="size-4" />
                            {t("inspectorView.replace")}
                        </Button>
                    </div>
                </div>
            </TabsContent>
            <TabsContent value="properties">
                <div className="space-y-4">
                    <Field label={t("fields.title")}>
                        <Input
                            value={props.draft.title}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, title: event.target.value }))}
                            className="border-zinc-800 bg-zinc-900 text-zinc-100"
                        />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("fields.kind")}>
                            <Input
                                value={props.draft.kind}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, kind: event.target.value }))}
                                className="border-zinc-800 bg-zinc-900 text-zinc-100"
                            />
                        </Field>
                        <Field label={t("fields.visibility")}>
                            <select
                                value={props.draft.visibility}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, visibility: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="private">{t("visibility.private")}</option>
                                <option value="company">{t("visibility.company")}</option>
                            </select>
                        </Field>
                        <Field label={t("fields.project")}>
                            <select
                                value={props.draft.projectId}
                                onChange={(event) => {
                                    const nextProjectId = event.target.value;
                                    const projectCustomerId = findProjectCustomerId(props.projects, nextProjectId);
                                    const candidateTask = props.tasks.find((task) => task.projectId === nextProjectId);
                                    props.onDraftChange((current) => ({
                                        ...current,
                                        projectId: nextProjectId,
                                        taskId: candidateTask?.id ?? "",
                                        customerId: nextProjectId ? projectCustomerId : current.customerId,
                                    }));
                                }}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="">{t("fields.none")}</option>
                                {props.projects.map((project) => (
                                    <option key={project.id} value={project.id}>{project.name}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label={t("fields.task")}>
                            <select
                                value={props.draft.taskId}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, taskId: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                disabled={!props.draft.projectId}
                            >
                                <option value="">{t("fields.none")}</option>
                                {props.tasks.filter((task) => task.projectId === props.draft.projectId).map((task) => (
                                    <option key={task.id} value={task.id}>{task.type}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label={t("fields.customer")}>
                            <select
                                value={props.draft.customerId}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, customerId: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                disabled={Boolean(props.draft.projectId)}
                            >
                                <option value="">{t("fields.none")}</option>
                                {props.customers.map((customer) => (
                                    <option key={customer.id} value={customer.id}>{customer.name}</option>
                                ))}
                            </select>
                        </Field>
                    </div>
                    <details className="rounded-2xl border border-zinc-800 bg-zinc-950/80">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-zinc-300">
                            {t("classification.title")}
                        </summary>
                        <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                            <p className="text-xs text-zinc-500">
                                {t("classification.hint")}
                            </p>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Field label={t("fields.fileRole")}>
                                    <select
                                        value={props.draft.artifactClass}
                                        onChange={(event) => props.onDraftChange((current) => ({ ...current, artifactClass: event.target.value }))}
                                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                    >
                                        {ARTIFACT_CLASS_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{taxonomy.classLabel(option.value)}</option>
                                        ))}
                                    </select>
                                </Field>
                                <Field label={t("fields.lifecycle")}>
                                    <select
                                        value={props.draft.importance}
                                        onChange={(event) => props.onDraftChange((current) => ({ ...current, importance: event.target.value }))}
                                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                    >
                                        {ARTIFACT_IMPORTANCE_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{taxonomy.importanceLabel(option.value)}</option>
                                        ))}
                                    </select>
                                </Field>
                                <Field label={t("fields.retentionPolicy")}>
                                    <Input
                                        value={props.draft.retentionPolicy}
                                        onChange={(event) => props.onDraftChange((current) => ({ ...current, retentionPolicy: event.target.value }))}
                                        className="border-zinc-800 bg-zinc-900 text-zinc-100"
                                    />
                                </Field>
                            </div>
                            <Field label={t("fields.metadataJson")}>
                                <Textarea
                                    value={props.draft.metadataJson}
                                    onChange={(event) => props.onDraftChange((current) => ({ ...current, metadataJson: event.target.value }))}
                                    className="min-h-40 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100"
                                />
                            </Field>
                        </div>
                    </details>
                    <label className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-300">
                        <input
                            type="checkbox"
                            checked={props.draft.isCanonical}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, isCanonical: event.target.checked }))}
                            className="size-4 rounded border-zinc-700 bg-zinc-900"
                        />
                        {t("inspectorView.markCanonical")}
                    </label>
                    <Field label={t("fields.filename")}>
                        <Input
                            value={props.locationDraft.name}
                            onChange={(event) => props.onLocationDraftChange((current) => ({ ...current, name: event.target.value }))}
                            className="border-zinc-800 bg-zinc-900 text-zinc-100"
                        />
                    </Field>
                    <Field label={t("fields.folder")}>
                        <select
                            value={props.locationDraft.folderId}
                            onChange={(event) => props.onLocationDraftChange((current) => ({ ...current, folderId: event.target.value }))}
                            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                        >
                            {props.knownFolders.map((folder) => (
                                <option key={folder.id} value={folder.id}>{folder.pathLabel}</option>
                            ))}
                        </select>
                    </Field>
                    <div className="grid gap-3 text-xs text-zinc-400 sm:grid-cols-2">
                        <InfoPill label={t("info.path")} value={props.artifact.path || "-"} />
                        <InfoPill label={HASH_LABEL} value={props.artifact.sha256 || "-"} mono />
                        <InfoPill label={t("info.size")} value={formatBytes(props.artifact.sizeBytes)} />
                        <InfoPill label={t("info.updated")} value={formatDate(props.artifact.updatedAt || props.artifact.createdAt)} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={props.onSaveProperties} disabled={props.isSavingArtifact || !props.hasPropertyChanges}>
                            {props.isSavingArtifact && <IconLoader2 className="size-4 animate-spin" />}
                            {t("inspectorView.saveProperties")}
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onSaveLocation} disabled={props.isSavingLocation || !props.hasLocationChanges}>
                            {props.isSavingLocation && <IconLoader2 className="size-4 animate-spin" />}
                            {t("inspectorView.saveLocation")}
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onReplace}>
                            {t("inspectorView.replace")}
                        </Button>
                        <Button variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20" onClick={props.onDelete}>
                            <IconTrash className="size-4" />
                            {t("delete")}
                        </Button>
                    </div>
                </div>
            </TabsContent>
        </Tabs>
    );
}

function FolderDialog(props: {
    open: boolean;
    draft: FolderDraft;
    projects: ProjectOption[];
    customers: CustomerOption[];
    isSaving: boolean;
    onOpenChange: (open: boolean) => void;
    onDraftChange: Dispatch<SetStateAction<FolderDraft>>;
    onSubmit: () => void;
}) {
    const t = useTranslations("artifacts");
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                <DialogHeader>
                    <DialogTitle>{t("folderDialog.title")}</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {t("folderDialog.description")}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <Field label={t("fields.folderName")}>
                        <Input
                            value={props.draft.name}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, name: event.target.value }))}
                            className="border-zinc-800 bg-zinc-900 text-zinc-100"
                        />
                    </Field>
                    <Field label={t("fields.project")}>
                        <select
                            value={props.draft.projectId}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, projectId: event.target.value }))}
                            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                        >
                            <option value="">{t("fields.none")}</option>
                            {props.projects.map((project) => (
                                <option key={project.id} value={project.id}>{project.name}</option>
                            ))}
                        </select>
                    </Field>
                    <Field label={t("fields.customer")}>
                        <select
                            value={props.draft.customerId}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, customerId: event.target.value }))}
                            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                        >
                            <option value="">{t("fields.none")}</option>
                            {props.customers.map((customer) => (
                                <option key={customer.id} value={customer.id}>{customer.name}</option>
                            ))}
                        </select>
                    </Field>
                    <details className="rounded-2xl border border-zinc-800 bg-zinc-950/80">
                        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-300">{t("folderMetadata.title")}</summary>
                        <div className="border-t border-zinc-800 px-4 py-4">
                            <p className="mb-3 text-xs leading-5 text-zinc-500">{t("folderMetadata.dialogHint")}</p>
                            <Field label={t("fields.metadataJson")}>
                                <Textarea
                                    value={props.draft.metadataJson}
                                    onChange={(event) => props.onDraftChange((current) => ({ ...current, metadataJson: event.target.value }))}
                                    className="min-h-28 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100"
                                />
                            </Field>
                        </div>
                    </details>
                </div>
                <DialogFooter>
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={() => props.onOpenChange(false)}>
                        {t("cancel")}
                    </Button>
                    <Button onClick={props.onSubmit} disabled={props.isSaving}>
                        {props.isSaving && <IconLoader2 className="size-4 animate-spin" />}
                        {t("create")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function NewFileDialog(props: {
    open: boolean;
    draft: NewFileDraft;
    projects: ProjectOption[];
    customers: CustomerOption[];
    isCreating: boolean;
    onOpenChange: (open: boolean) => void;
    onDraftChange: Dispatch<SetStateAction<NewFileDraft>>;
    onSubmit: () => void;
}) {
    const t = useTranslations("artifacts");
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-xl">
                <DialogHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10">
                        <IconFilePlus className="size-5 text-cyan-200" />
                    </div>
                    <DialogTitle>{t("newFileDialog.title")}</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {t("newFileDialog.description")}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-5">
                    <div className="space-y-2">
                        <div className="text-sm font-medium text-zinc-300">{t("newFileDialog.fileType")}</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {CREATABLE_FILE_TYPES.map((option) => {
                                const selected = props.draft.type === option.value;
                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        aria-pressed={selected}
                                        onClick={() => props.onDraftChange((current) => ({
                                            ...current,
                                            type: option.value,
                                            name: replaceKnownFileExtension(current.name, option.extension),
                                        }))}
                                        className={cn(
                                            "min-h-24 cursor-pointer rounded-xl border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70",
                                            selected
                                                ? "border-cyan-500/60 bg-cyan-500/10"
                                                : "border-zinc-800 bg-zinc-900/70 hover:border-zinc-700 hover:bg-zinc-900"
                                        )}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="text-sm font-medium text-zinc-100">{t(`fileTypes.${option.value}.label`)}</div>
                                            <span className="rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-400">
                                                {option.extension.slice(1)}
                                            </span>
                                        </div>
                                        <div className="mt-1 text-xs leading-5 text-zinc-500">{t(`fileTypes.${option.value}.description`)}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <Field label={t("fields.filename")}>
                        <Input
                            autoFocus
                            value={props.draft.name}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, name: event.target.value }))}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && props.draft.name.trim() && !props.isCreating) props.onSubmit();
                            }}
                            placeholder={untitledFileName(props.draft.type)}
                            className="border-zinc-800 bg-zinc-900 text-zinc-100"
                        />
                        <span className="text-xs text-zinc-500">{t("newFileDialog.extensionHint")}</span>
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("fields.customer")}>
                            <select
                                value={props.draft.customerId}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, customerId: event.target.value }))}
                                disabled={Boolean(props.draft.projectId)}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value="">{t("fields.companyNoCustomer")}</option>
                                {props.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                            </select>
                        </Field>
                        <Field label={t("fields.project")}>
                            <select
                                value={props.draft.projectId}
                                onChange={(event) => {
                                    const projectId = event.target.value;
                                    props.onDraftChange((current) => ({
                                        ...current,
                                        projectId,
                                        customerId: projectId ? findProjectCustomerId(props.projects, projectId) : current.customerId,
                                    }));
                                }}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="">{t("fields.none")}</option>
                                {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                            </select>
                        </Field>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={props.isCreating} className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800">
                        {t("cancel")}
                    </Button>
                    <Button className="cursor-pointer disabled:cursor-not-allowed" onClick={props.onSubmit} disabled={props.isCreating || !props.draft.name.trim()}>
                        {props.isCreating ? <IconLoader2 className="size-4 animate-spin" /> : <IconFilePlus className="size-4" />}
                        {t("newFileDialog.submit")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function RenameFileDialog(props: {
    draft: RenameFileDraft | null;
    isRenaming: boolean;
    onDraftChange: Dispatch<SetStateAction<RenameFileDraft | null>>;
    onOpenChange: (open: boolean) => void;
    onSubmit: () => void;
}) {
    const t = useTranslations("artifacts");
    return (
        <Dialog open={Boolean(props.draft)} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
                <DialogHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10">
                        <IconPencil className="size-5 text-cyan-200" />
                    </div>
                    <DialogTitle>{t("renameDialog.title")}</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {t("renameDialog.description")}
                    </DialogDescription>
                </DialogHeader>
                <Field label={t("fields.fileName")}>
                    <div className="flex min-h-11 items-center rounded-md border border-zinc-800 bg-zinc-900 focus-within:ring-2 focus-within:ring-cyan-400/70">
                        <Input
                            autoFocus
                            value={props.draft?.baseName ?? ""}
                            onChange={(event) => props.onDraftChange((current) => current ? { ...current, baseName: event.target.value } : current)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && props.draft?.baseName.trim() && !props.isRenaming) props.onSubmit();
                            }}
                            aria-describedby="rename-file-extension-hint"
                            className="h-10 min-w-0 flex-1 border-0 bg-transparent text-zinc-100 shadow-none focus-visible:ring-0"
                        />
                        {props.draft?.extension && (
                            <span className="shrink-0 border-l border-zinc-800 px-3 font-mono text-sm text-zinc-400">
                                {props.draft.extension}
                            </span>
                        )}
                    </div>
                    <span id="rename-file-extension-hint" className="text-xs text-zinc-500">
                        {t("renameDialog.extensionHint")}
                    </span>
                </Field>
                <DialogFooter>
                    <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={props.isRenaming} className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800">
                        {t("cancel")}
                    </Button>
                    <Button onClick={props.onSubmit} disabled={props.isRenaming || !props.draft?.baseName.trim()}>
                        {props.isRenaming ? <IconLoader2 className="size-4 animate-spin" /> : <IconPencil className="size-4" />}
                        {t("menu.rename")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function UploadDialog(props: {
    open: boolean;
    uploadFile: File | null;
    uploadTitle: string;
    uploadKind: string;
    uploadArtifactClass: string;
    uploadImportance: string;
    uploadProjectId: string;
    uploadTaskId: string;
    uploadCustomerId: string;
    uploadMetadataJson: string;
    projects: ProjectOption[];
    tasks: TaskOption[];
    customers: CustomerOption[];
    isUploading: boolean;
    onOpenChange: (open: boolean) => void;
    onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onTitleChange: (value: string) => void;
    onKindChange: (value: string) => void;
    onArtifactClassChange: (value: string) => void;
    onImportanceChange: (value: string) => void;
    onProjectChange: (value: string) => void;
    onCustomerChange: (value: string) => void;
    onMetadataJsonChange: (value: string) => void;
    onSubmit: () => void;
}) {
    const t = useTranslations("artifacts");
    const taxonomy = useArtifactTaxonomy();
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                <DialogHeader>
                    <DialogTitle>{t("uploadDialog.title")}</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {t("uploadDialog.description")}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <Field label={t("fields.file")}>
                        <Input type="file" onChange={props.onFileChange} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                    </Field>
                    <Field label={t("fields.title")}>
                        <Input value={props.uploadTitle} onChange={(event) => props.onTitleChange(event.target.value)} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("fields.customer")}>
                            <select
                                value={props.uploadCustomerId}
                                onChange={(event) => props.onCustomerChange(event.target.value)}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                disabled={Boolean(props.uploadProjectId)}
                            >
                                <option value="">{t("fields.companyNoCustomer")}</option>
                                {props.customers.map((customer) => (
                                    <option key={customer.id} value={customer.id}>{customer.name}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label={t("fields.project")}>
                            <select value={props.uploadProjectId} onChange={(event) => props.onProjectChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                <option value="">{t("fields.none")}</option>
                                {props.projects.map((project) => (
                                    <option key={project.id} value={project.id}>{project.name}</option>
                                ))}
                            </select>
                        </Field>
                    </div>
                    <details className="rounded-xl border border-zinc-800 bg-zinc-950/70">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-zinc-300">
                            {t("uploadDialog.advanced")}
                        </summary>
                        <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                            <p className="text-xs text-zinc-500">
                                {t("uploadDialog.advancedHint")}
                            </p>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Field label={t("fields.kind")}>
                                    <Input value={props.uploadKind} onChange={(event) => props.onKindChange(event.target.value)} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                                </Field>
                                <Field label={t("fields.fileRole")}>
                                    <select value={props.uploadArtifactClass} onChange={(event) => props.onArtifactClassChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                        {ARTIFACT_CLASS_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{taxonomy.classLabel(option.value)}</option>
                                        ))}
                                    </select>
                                </Field>
                                <Field label={t("fields.lifecycle")}>
                                    <select value={props.uploadImportance} onChange={(event) => props.onImportanceChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                        {ARTIFACT_IMPORTANCE_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{taxonomy.importanceLabel(option.value)}</option>
                                        ))}
                                    </select>
                                </Field>
                            </div>
                            <Field label={t("fields.metadataJson")}>
                                <Textarea value={props.uploadMetadataJson} onChange={(event) => props.onMetadataJsonChange(event.target.value)} className="min-h-28 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100" />
                            </Field>
                        </div>
                    </details>
                </div>
                <DialogFooter>
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={() => props.onOpenChange(false)}>
                        {t("cancel")}
                    </Button>
                    <Button onClick={props.onSubmit} disabled={props.isUploading}>
                        {props.isUploading && <IconLoader2 className="size-4 animate-spin" />}
                        {t("upload")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function TrackExternalDialog(props: {
    entry: DiscoveredStorageEntry | null;
    title: string;
    kind: string;
    artifactClass: string;
    importance: string;
    projectId: string;
    customerId: string;
    metadataJson: string;
    projects: ProjectOption[];
    customers: CustomerOption[];
    isSaving: boolean;
    onOpenChange: (open: boolean) => void;
    onTitleChange: (value: string) => void;
    onKindChange: (value: string) => void;
    onArtifactClassChange: (value: string) => void;
    onImportanceChange: (value: string) => void;
    onProjectChange: (value: string) => void;
    onCustomerChange: (value: string) => void;
    onMetadataJsonChange: (value: string) => void;
    onSubmit: () => void;
}) {
    const t = useTranslations("artifacts");
    const taxonomy = useArtifactTaxonomy();
    return (
        <Dialog open={Boolean(props.entry)} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-lg">
                <DialogHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10">
                        <IconQuestionMark className="size-5 text-amber-200" />
                    </div>
                    <DialogTitle>{t("trackDialog.title")}</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {t("trackDialog.description")}
                    </DialogDescription>
                </DialogHeader>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                    <div className="truncate text-sm font-medium text-zinc-100">{props.entry?.name}</div>
                    <div className="truncate text-xs text-zinc-500">{props.entry?.logicalPath}</div>
                </div>
                <div className="space-y-4">
                    <Field label={t("fields.title")}>
                        <Input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t("fields.customer")}>
                            <select
                                value={props.customerId}
                                onChange={(event) => props.onCustomerChange(event.target.value)}
                                disabled={Boolean(props.projectId)}
                                className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value="">{t("fields.selectCustomer")}</option>
                                {props.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                            </select>
                        </Field>
                        <Field label={t("fields.project")}>
                            <select value={props.projectId} onChange={(event) => props.onProjectChange(event.target.value)} className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                <option value="">{t("fields.none")}</option>
                                {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                            </select>
                        </Field>
                    </div>
                    <details className="rounded-xl border border-zinc-800 bg-zinc-950/70">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-zinc-300">{t("classification.title")}</summary>
                        <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                            <Field label={t("fields.kind")}>
                                <Input value={props.kind} onChange={(event) => props.onKindChange(event.target.value)} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                            </Field>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Field label={t("fields.fileRole")}>
                                    <select value={props.artifactClass} onChange={(event) => props.onArtifactClassChange(event.target.value)} className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                        {ARTIFACT_CLASS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{taxonomy.classLabel(option.value)}</option>)}
                                    </select>
                                </Field>
                                <Field label={t("fields.lifecycle")}>
                                    <select value={props.importance} onChange={(event) => props.onImportanceChange(event.target.value)} className="h-11 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                        {ARTIFACT_IMPORTANCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{taxonomy.importanceLabel(option.value)}</option>)}
                                    </select>
                                </Field>
                            </div>
                            <Field label={t("fields.metadataJson")}>
                                <Textarea value={props.metadataJson} onChange={(event) => props.onMetadataJsonChange(event.target.value)} className="min-h-24 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100" />
                            </Field>
                        </div>
                    </details>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={props.isSaving} className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800">{t("cancel")}</Button>
                    <Button onClick={props.onSubmit} disabled={props.isSaving || (!props.projectId && !props.customerId)}>
                        {props.isSaving && <IconLoader2 className="size-4 animate-spin" />}
                        {t("trackDialog.submit")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PreviewDialog(props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    artifact: ArtifactDetail | null;
    preview: PreviewState;
    activeTab: string;
    onTabChange: (value: string) => void;
    csvRows: string[][];
    csvRawDraft: string;
    csvRawError: string | null;
    isSavingCsv: boolean;
    isCsvDirty: boolean;
    textDraft: string;
    textError: string | null;
    isTextDirty: boolean;
    onCsvCellChange: (rowIndex: number, columnIndex: number, value: string) => void;
    onAddCsvRow: () => void;
    onDeleteCsvRow: (rowIndex: number) => void;
    onAddCsvColumn: () => void;
    onDeleteCsvColumn: (columnIndex: number) => void;
    onCsvRawDraftChange: (value: string) => void;
    onApplyRawCsvToGrid: () => void;
    onResetCsvDraft: () => void;
    onSaveCsvDraft: () => void;
    onTextDraftChange: (value: string) => void;
    onResetTextDraft: () => void;
    onSaveTextDraft: () => void;
}) {
    const t = useTranslations("artifacts");
    const isCsvPreview = props.preview.state === "csv";
    const isTextPreview = props.preview.state === "markdown" || props.preview.state === "json" || props.preview.state === "text";
    const title = props.artifact ? deriveDisplayName(props.artifact) : t("previewDialog.fallbackTitle");

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="max-h-[92vh] overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-6xl">
                <div className="flex h-full max-h-[92vh] flex-col">
                    <DialogHeader className="border-b border-zinc-800 px-6 py-5 pr-14">
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription className="text-zinc-400">
                            {isCsvPreview
                                ? t("previewDialog.csvDescription")
                                : isTextPreview
                                    ? t("previewDialog.textDescription")
                                    : t("previewDialog.description")}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">
                        {isCsvPreview ? (
                            <Tabs value={props.activeTab} onValueChange={props.onTabChange} className="flex h-full min-h-0 flex-col">
                                <TabsList variant="line" className="mb-4 border-b border-zinc-800 pb-1">
                                    <TabsTrigger value="preview">{t("tabs.preview")}</TabsTrigger>
                                    <TabsTrigger value="table">{t("tabs.grid")}</TabsTrigger>
                                    <TabsTrigger value="raw">{t("tabs.raw")}</TabsTrigger>
                                </TabsList>
                                <TabsContent value="preview" className="min-h-0 flex-1">
                                    <div className="h-full overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
                                        <PreviewPanel preview={props.preview} />
                                    </div>
                                </TabsContent>
                                <TabsContent value="table" className="min-h-0 flex-1">
                                    <CsvGridEditor
                                        rows={props.csvRows}
                                        onCellChange={props.onCsvCellChange}
                                        onAddRow={props.onAddCsvRow}
                                        onDeleteRow={props.onDeleteCsvRow}
                                        onAddColumn={props.onAddCsvColumn}
                                        onDeleteColumn={props.onDeleteCsvColumn}
                                    />
                                </TabsContent>
                                <TabsContent value="raw" className="min-h-0 flex-1">
                                    <div className="flex h-full min-h-0 flex-col gap-4">
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                                            <span>
                                                {t("previewDialog.rawHint")}
                                            </span>
                                            <Button
                                                variant="outline"
                                                className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                                                onClick={props.onApplyRawCsvToGrid}
                                            >
                                                {t("previewDialog.refreshGrid")}
                                            </Button>
                                        </div>
                                        <Textarea
                                            value={props.csvRawDraft}
                                            onChange={(event) => props.onCsvRawDraftChange(event.target.value)}
                                            className="min-h-0 flex-1 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100"
                                        />
                                        {props.csvRawError && (
                                            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                                                {props.csvRawError}
                                            </div>
                                        )}
                                    </div>
                                </TabsContent>
                            </Tabs>
                        ) : isTextPreview ? (
                            <Tabs value={props.activeTab} onValueChange={props.onTabChange} className="flex h-full min-h-0 flex-col">
                                <TabsList variant="line" className="mb-4 border-b border-zinc-800 pb-1">
                                    <TabsTrigger value="preview">{t("tabs.preview")}</TabsTrigger>
                                    <TabsTrigger value="edit">{t("tabs.editor")}</TabsTrigger>
                                </TabsList>
                                <TabsContent value="preview" className="min-h-0 flex-1">
                                    <div className="h-full overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
                                        <PreviewPanel preview={props.preview} />
                                    </div>
                                </TabsContent>
                                <TabsContent value="edit" className="min-h-0 flex-1">
                                    <div className="flex h-full min-h-0 flex-col gap-3">
                                        <Textarea
                                            value={props.textDraft}
                                            onChange={(event) => props.onTextDraftChange(event.target.value)}
                                            spellCheck={props.preview.state !== "json"}
                                            aria-label={t("previewDialog.fileContents")}
                                            className="min-h-[50vh] flex-1 resize-none border-zinc-800 bg-zinc-900 font-mono text-sm leading-6 text-zinc-100"
                                        />
                                        {props.textError && (
                                            <div role="alert" className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                                                {props.textError}
                                            </div>
                                        )}
                                    </div>
                                </TabsContent>
                            </Tabs>
                        ) : (
                            <div className="h-full overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
                                <PreviewPanel preview={props.preview} />
                            </div>
                        )}
                    </div>

                    <DialogFooter className="border-t border-zinc-800 px-6 py-4 sm:justify-between">
                        <div className="text-xs text-zinc-500">
                            {isCsvPreview || isTextPreview
                                ? t("previewDialog.savingHint")
                                : t("previewDialog.actionsHint")}
                        </div>
                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                            {isCsvPreview && (
                                <>
                                    <Button
                                        variant="outline"
                                        className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                                        onClick={props.onResetCsvDraft}
                                        disabled={props.isSavingCsv || !props.isCsvDirty}
                                    >
                                        <IconRefresh className="size-4" />
                                        {t("previewDialog.reset")}
                                    </Button>
                                    <Button onClick={props.onSaveCsvDraft} disabled={props.isSavingCsv || !props.isCsvDirty}>
                                        {props.isSavingCsv ? <IconLoader2 className="size-4 animate-spin" /> : <IconDeviceFloppy className="size-4" />}
                                        {t("previewDialog.saveCsv")}
                                    </Button>
                                </>
                            )}
                            {isTextPreview && (
                                <>
                                    <Button
                                        variant="outline"
                                        className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                                        onClick={props.onResetTextDraft}
                                        disabled={props.isSavingCsv || !props.isTextDirty}
                                    >
                                        <IconRefresh className="size-4" />
                                        {t("previewDialog.reset")}
                                    </Button>
                                    <Button onClick={props.onSaveTextDraft} disabled={props.isSavingCsv || !props.isTextDirty}>
                                        {props.isSavingCsv ? <IconLoader2 className="size-4 animate-spin" /> : <IconDeviceFloppy className="size-4" />}
                                        {t("previewDialog.saveFile")}
                                    </Button>
                                </>
                            )}
                            <Button
                                variant="outline"
                                className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                                onClick={() => props.onOpenChange(false)}
                            >
                                {t("previewDialog.close")}
                            </Button>
                        </div>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function CsvGridEditor(props: {
    rows: string[][];
    onCellChange: (rowIndex: number, columnIndex: number, value: string) => void;
    onAddRow: () => void;
    onDeleteRow: (rowIndex: number) => void;
    onAddColumn: () => void;
    onDeleteColumn: (columnIndex: number) => void;
}) {
    const t = useTranslations("artifacts");
    const columnCount = getCsvColumnCount(props.rows);

    return (
        <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-zinc-500">
                    {t("csv.hint")}
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onAddColumn}>
                        <IconPlus className="size-4" />
                        {t("csv.addColumn")}
                    </Button>
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onAddRow}>
                        <IconPlus className="size-4" />
                        {t("csv.addRow")}
                    </Button>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/80">
                <table className="min-w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                        <tr>
                            <th className="w-28 border-b border-r border-zinc-800 px-3 py-3 text-left text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                                {t("csv.row")}
                            </th>
                            {Array.from({ length: columnCount }, (_, columnIndex) => (
                                <th key={`column-${columnIndex}`} className="min-w-52 border-b border-zinc-800 px-3 py-3 text-left">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                                            {t("csv.columnN", { n: columnIndex + 1 })}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            className="text-zinc-500 hover:text-zinc-100"
                                            onClick={() => props.onDeleteColumn(columnIndex)}
                                        >
                                            <IconTrash className="size-4" />
                                        </Button>
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {props.rows.map((row, rowIndex) => (
                            <tr key={`csv-row-${rowIndex}`} className={rowIndex === 0 ? "bg-zinc-900/60" : ""}>
                                <td className="border-r border-zinc-800 px-3 py-2 align-top">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-xs text-zinc-500">
                                            {rowIndex === 0 ? t("csv.header") : t("csv.rowN", { n: rowIndex + 1 })}
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            className="text-zinc-500 hover:text-zinc-100"
                                            onClick={() => props.onDeleteRow(rowIndex)}
                                        >
                                            <IconTrash className="size-4" />
                                        </Button>
                                    </div>
                                </td>
                                {row.map((cell, columnIndex) => (
                                    <td key={`csv-cell-${rowIndex}-${columnIndex}`} className="border-l border-t border-zinc-800 p-2 align-top first:border-l-0">
                                        <Input
                                            value={cell}
                                            onChange={(event) => props.onCellChange(rowIndex, columnIndex, event.target.value)}
                                            className="border-zinc-700 bg-zinc-900 text-zinc-100"
                                        />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function PreviewPanel({ preview }: { preview: PreviewState }) {
    const t = useTranslations("artifacts");
    if (preview.state === "idle" || preview.state === "loading") {
        return (
            <div className="flex min-h-80 items-center justify-center text-sm text-zinc-400">
                {preview.state === "loading" ? <><IconLoader2 className="mr-2 size-4 animate-spin" />{t("preview.loading")}</> : t("preview.selectFile")}
            </div>
        );
    }
    if (preview.state === "error") {
        return <div className="min-h-80 rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-200">{preview.message}</div>;
    }
    if (preview.state === "unsupported") {
        return (
            <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/80 p-6 text-center">
                <p className="text-sm text-zinc-400">{preview.message}</p>
                <p className="text-xs text-zinc-500">{t("preview.downloadHint")}</p>
            </div>
        );
    }
    if (preview.state === "markdown") {
        return <div className="min-h-80"><MarkdownRenderer content={preview.text} className="prose-sm" /></div>;
    }
    if (preview.state === "json") {
        return <pre className="min-h-80 overflow-auto rounded-xl bg-zinc-950 p-4 font-mono text-xs text-zinc-200">{preview.text}</pre>;
    }
    if (preview.state === "text") {
        return <pre className="min-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-950 p-4 font-mono text-xs text-zinc-200">{preview.text}</pre>;
    }
    if (preview.state === "csv") {
        return (
            <div className="overflow-auto">
                <table className="min-w-full border-collapse text-sm">
                    <tbody>
                        {preview.rows.map((row, rowIndex) => (
                            <tr key={`row-${rowIndex}`} className={rowIndex === 0 ? "bg-zinc-900/80" : ""}>
                                {row.map((cell, cellIndex) => (
                                    <td key={`cell-${rowIndex}-${cellIndex}`} className="border border-zinc-800 px-3 py-2 text-zinc-200">
                                        {cell}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }
    if (preview.state === "image") {
        return <img src={preview.url} alt={t("preview.imageAlt")} className="max-h-[32rem] w-full rounded-xl object-contain" />;
    }
    if (preview.state === "pdf") {
        return <iframe src={preview.url} title={t("preview.pdfTitle")} className="h-[32rem] w-full rounded-xl border border-zinc-800 bg-white" />;
    }
    if (preview.state === "xlsx-preview") {
        return (
            <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <span className="text-xs text-zinc-400 font-medium">{t("preview.spreadsheetReadOnly")}</span>
                    <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                        <a href={`/artifacts/${preview.id}/edit`}>
                            <IconPencil className="mr-1.5 size-3.5" />
                            {t("preview.openEditor")}
                        </a>
                    </Button>
                </div>
                <div className="h-[32rem] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
                    <XlsxViewer
                        file={preview.bytes}
                        readOnly={true}
                        height="100%"
                        rounded={false}
                        showDefaultToolbar={false}
                        isDark={true}
                    />
                </div>
            </div>
        );
    }
    if (preview.state === "docx-preview") {
        return (
            <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <span className="text-xs text-zinc-400 font-medium">{t("preview.documentReadOnly")}</span>
                    <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                        <a href={`/artifacts/${preview.id}/edit`}>
                            <IconPencil className="mr-1.5 size-3.5" />
                            {t("preview.openEditor")}
                        </a>
                    </Button>
                </div>
                <div className="h-[32rem] overflow-auto rounded-xl border border-zinc-800 bg-[#1e1e22] p-4 text-zinc-100 force-dark">
                    <ReactDocxViewer
                        file={preview.bytes}
                        className="h-full w-full"
                    />
                </div>
            </div>
        );
    }
    if (preview.state === "office") {
        const isExcel = preview.name.endsWith(".xls") || preview.name.endsWith(".xlsx") || preview.name.endsWith(".ods");
        const Icon = isExcel ? IconFileSpreadsheet : IconFileText;
        return (
            <div className="flex min-h-60 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/80 p-6 text-center">
                <Icon className={cn("size-12", isExcel ? "text-emerald-300" : "text-blue-300")} />
                <div>
                    <h3 className="text-sm font-medium text-zinc-200">{preview.name}</h3>
                    <p className="mt-1 text-xs text-zinc-500">
                        {isExcel ? t("preview.spreadsheetFile") : t("preview.wordDocument")}
                    </p>
                </div>
                <div className="flex gap-2">
                    {preview.isEditable && (
                        <Button asChild size="sm">
                            <a href={`/artifacts/${preview.id}/edit`}>
                                <IconPencil className="mr-2 size-4" />
                                {t("preview.editDocument")}
                            </a>
                        </Button>
                    )}
                    <Button asChild variant="outline" size="sm">
                        <a href={preview.url} download={preview.name}>
                            <IconArrowDown className="mr-2 size-4" />
                            {t("menu.download")}
                        </a>
                    </Button>
                </div>
            </div>
        );
    }
    return null;
}

function Field(props: { label: string; children: ReactNode }) {
    return (
        <label className="block space-y-2">
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">{props.label}</span>
            {props.children}
        </label>
    );
}

function InfoPill(props: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{props.label}</div>
            <div className={cn("mt-1 truncate text-zinc-200", props.mono && "font-mono text-[11px]")}>{props.value}</div>
        </div>
    );
}

function EmptyInspector() {
    const t = useTranslations("artifacts");
    return (
        <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/80 px-6 text-center">
            <IconSettings className="mb-4 size-8 text-zinc-600" />
            <h3 className="text-lg font-medium text-zinc-100">{t("emptyInspector.title")}</h3>
            <p className="mt-2 text-sm text-zinc-400">
                {t("emptyInspector.description")}
            </p>
        </div>
    );
}

function renderArtifactIcon(artifact: Pick<ArtifactSummary, "contentType" | "originalFilename">) {
    const name = artifact.originalFilename?.toLowerCase() || "";
    const contentType = artifact.contentType.toLowerCase();

    if (contentType.includes("json") || name.endsWith(".json")) return <IconFileTypeJs className="size-4 text-sky-300" />;
    if (contentType.includes("csv") || name.endsWith(".csv") || name.endsWith(".xlsx") || name.endsWith(".xls")) return <IconFileSpreadsheet className="size-4 text-emerald-300" />;
    if (contentType.includes("markdown") || name.endsWith(".md")) return <IconFileCode className="size-4 text-cyan-300" />;
    if (contentType.includes("image/")) return <IconPhoto className="size-4 text-rose-300" />;
    if (contentType.includes("pdf") || name.endsWith(".pdf")) return <IconFileText className="size-4 text-red-300" />;
    if (name.endsWith(".zip") || name.endsWith(".tar") || name.endsWith(".gz")) return <IconFileZip className="size-4 text-amber-300" />;
    if (contentType.startsWith("text/")) return <IconFileText className="size-4 text-zinc-300" />;
    return <IconFile className="size-4 text-zinc-300" />;
}

function buildArtifactContextLabel(artifact: ArtifactSummary) {
    return [artifact.projectGoal, artifact.taskType, artifact.customerName].filter(Boolean).join(" · ") || artifact.kind;
}

function deriveDisplayName(artifact: Pick<ArtifactSummary, "title" | "originalFilename" | "path" | "kind">) {
    return artifact.originalFilename || artifact.title || artifact.path?.split("/").pop() || artifact.kind;
}

function canEditOfficeArtifact(artifact: Pick<ArtifactSummary, "originalFilename" | "title">) {
    const name = (artifact.originalFilename || artifact.title || "").toLowerCase();
    return name.endsWith(".xlsx") || name.endsWith(".docx");
}

function buildKnownFolders(cache: Record<string, FolderContentsResponse>, rootLabel: string) {
    const folders = new Map<string, { id: string; pathLabel: string }>();
    folders.set(ROOT_ID, { id: ROOT_ID, pathLabel: rootLabel });
    for (const payload of Object.values(cache)) {
        if (payload.folder.id !== ROOT_ID) {
            folders.set(payload.folder.id, { id: payload.folder.id, pathLabel: payload.folder.path || payload.folder.name });
        }
        for (const folder of payload.folders) {
            folders.set(folder.id, { id: folder.id, pathLabel: folder.path });
        }
    }
    return Array.from(folders.values()).sort((left, right) => {
        if (left.id === ROOT_ID) return -1;
        if (right.id === ROOT_ID) return 1;
        return left.pathLabel.localeCompare(right.pathLabel);
    });
}

function getParentFolderId(folderId: string, cache: Record<string, FolderContentsResponse>) {
    if (folderId === ROOT_ID) {
        return null;
    }
    for (const payload of Object.values(cache)) {
        if (payload.folders.some((folder) => folder.id === folderId)) {
            return payload.folder.id === ROOT_ID ? null : payload.folder.id;
        }
    }
    return null;
}

function findFolderById(cache: Record<string, FolderContentsResponse>, folderId: string) {
    if (folderId === ROOT_ID) {
        return { id: ROOT_ID, name: "Root", path: "", projectId: null, customerId: null, metadataJson: {} };
    }
    for (const payload of Object.values(cache)) {
        if (payload.folder.id === folderId) return payload.folder;
        const nested = payload.folders.find((folder) => folder.id === folderId);
        if (nested) return nested;
    }
    return null;
}

async function readError(response: Response, fallback: string) {
    try {
        const payload = await response.json() as { error?: string };
        return payload.error || fallback;
    } catch {
        return fallback;
    }
}

async function fetchArtifactText(artifactId: string) {
    const response = await fetch(`/api/ui/artifacts/${artifactId}/download?disposition=inline`, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(await readError(response, "Unable to load text preview"));
    }
    return await response.text();
}

async function fetchArtifactBlob(artifactId: string) {
    const response = await fetch(`/api/ui/artifacts/${artifactId}/download?disposition=inline`, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(await readError(response, "Unable to load binary preview"));
    }
    return await response.blob();
}

function clearPreviewUrl(ref: MutableRefObject<string | null>) {
    if (ref.current) {
        URL.revokeObjectURL(ref.current);
        ref.current = null;
    }
}

function getPreviewMode(artifact: Pick<ArtifactDetail, "contentType" | "originalFilename">) {
    const contentType = artifact.contentType.toLowerCase();
    const name = artifact.originalFilename?.toLowerCase() || "";
    if (contentType.includes("markdown") || name.endsWith(".md")) return "markdown";
    if (contentType.includes("json") || name.endsWith(".json")) return "json";
    if (contentType.includes("csv") || name.endsWith(".csv")) return "csv";
    if (contentType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("text/")) return "text";
    // Office / OpenDocument formats
    if (
        contentType.includes("spreadsheet") || contentType.includes("excel") ||
        name.endsWith(".xls") || name.endsWith(".xlsx") || name.endsWith(".ods") ||
        contentType.includes("word") || contentType.includes("document") &&
        !contentType.includes("pdf") ||
        name.endsWith(".doc") || name.endsWith(".docx") || name.endsWith(".odt") ||
        contentType.includes("presentation") || contentType.includes("powerpoint") ||
        name.endsWith(".ppt") || name.endsWith(".pptx") || name.endsWith(".odp")
    ) {
        return "office";
    }
    return "unsupported";
}

function parseJsonInput(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
        return {};
    }
    return JSON.parse(trimmed) as Record<string, unknown>;
}

function normalizeJsonInput(value: string) {
    try {
        return JSON.stringify(parseJsonInput(value));
    } catch {
        return value.trim();
    }
}

function normalizeJsonValue(value: unknown) {
    return JSON.stringify(value ?? {});
}

function formatJson(value: unknown) {
    return JSON.stringify(value ?? {}, null, 2);
}

function formatJsonSafely(value: string) {
    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
        return value;
    }
}

async function createInitialFileContent(fileType: (typeof CREATABLE_FILE_TYPES)[number]): Promise<string | ArrayBuffer> {
    if (fileType.initialContent !== null) return fileType.initialContent;

    const { strToU8, zipSync } = await import("fflate");
    const entries: Record<string, Uint8Array> = fileType.value === "xlsx" ? {
        "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
        "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
        "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
        "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
        "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`),
        "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    } : {
        "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
        "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
        "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
        "word/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`),
        "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    };
    const bytes = zipSync(entries, { level: 6 });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function getCreatableFileType(type: CreatableFileType) {
    return CREATABLE_FILE_TYPES.find((option) => option.value === type) ?? CREATABLE_FILE_TYPES[0];
}

function replaceKnownFileExtension(name: string, extension: string) {
    const trimmed = name.trim() || "untitled";
    const knownExtension = CREATABLE_FILE_TYPES.find((option) => trimmed.toLowerCase().endsWith(option.extension));
    const baseName = knownExtension ? trimmed.slice(0, -knownExtension.extension.length) : trimmed;
    return `${baseName || "untitled"}${extension}`;
}

function ensureFileExtension(name: string, extension: string) {
    const trimmed = name.trim();
    return trimmed.toLowerCase().endsWith(extension) ? trimmed : `${trimmed}${extension}`;
}

function splitFileNameExtension(name: string) {
    const lastDot = name.lastIndexOf(".");
    if (lastDot <= 0 || lastDot === name.length - 1) return { baseName: name, extension: "" };
    return { baseName: name.slice(0, lastDot), extension: name.slice(lastDot) };
}

function isValidStorageFileName(name: string) {
    return Boolean(name.trim()) && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function parseCsvPreview(value: string) {
    return normalizeCsvRows(parseCsvDocument(value).slice(0, 25));
}

function parseCsvDocument(value: string) {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQuotes = false;

    for (let index = 0; index < value.length; index += 1) {
        const current = value[index];
        const next = value[index + 1];

        if (current === "\"") {
            if (inQuotes && next === "\"") {
                cell += "\"";
                index += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }

        if (!inQuotes && current === ",") {
            row.push(cell);
            cell = "";
            continue;
        }

        if (!inQuotes && (current === "\n" || current === "\r")) {
            if (current === "\r" && next === "\n") {
                index += 1;
            }
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
            continue;
        }

        cell += current;
    }

    if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }

    return rows.length ? rows : [[""]];
}

function serializeCsv(rows: string[][]) {
    return rows
        .map((row) => row.map(escapeCsvCell).join(","))
        .join("\n");
}

function escapeCsvCell(value: string) {
    if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, "\"\"")}"`;
    }
    return value;
}

function normalizeCsvRows(rows: string[][]) {
    const safeRows = rows.length ? rows.filter((row) => row.length > 0) : [[""]];
    const columnCount = Math.max(1, ...safeRows.map((row) => row.length));
    return safeRows.map((row) => {
        const nextRow = [...row];
        while (nextRow.length < columnCount) {
            nextRow.push("");
        }
        return nextRow;
    });
}

function getCsvColumnCount(rows: string[][]) {
    return Math.max(1, ...rows.map((row) => row.length));
}

function normalizeTextForCompare(value: string) {
    return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function formatBytes(value: number) {
    if (!Number.isFinite(value) || value < 0) return "-";
    const units = ["B", "KB", "MB", "GB"];
    let amount = value;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
        amount /= 1024;
        index += 1;
    }
    return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** "Oct 29, 2026" in the viewer's language; "-" when missing or invalid. */
function useRelativeDate() {
    const format = useFormatter();
    return (value?: string) => {
        if (!value) return "-";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "-";
        return format.dateTime(date, { month: "short", day: "numeric", year: "numeric" });
    };
}

const ARTIFACT_CLASSES = new Set<string>(ARTIFACT_CLASS_OPTIONS.map((option) => option.value));
const ARTIFACT_IMPORTANCES = new Set<string>(ARTIFACT_IMPORTANCE_OPTIONS.map((option) => option.value));

/** File role and lifecycle labels (artifacts.classes / artifacts.importance); unknown values keep the English helper's wording. */
function useArtifactTaxonomy() {
    const t = useTranslations("artifacts");
    return {
        classLabel: (value?: string | null) => (value && ARTIFACT_CLASSES.has(value) ? t(`classes.${value as "proof"}.label`) : value ? getArtifactClassLabel(value) : t("unclassified")),
        importanceLabel: (value?: string | null) => (value && ARTIFACT_IMPORTANCES.has(value) ? t(`importance.${value as "record"}.label`) : value ? getArtifactImportanceLabel(value) : t("importance.operational.label")),
        classDescription: (value: string) => t(`classes.${value as "proof"}.description`),
        importanceDescription: (value: string) => t(`importance.${value as "record"}.description`),
    };
}

function resetUploadState(
    projectId: string,
    customerId: string,
    setUploadFile: (value: File | null) => void,
    setUploadTitle: (value: string) => void,
    setUploadKind: (value: string) => void,
    setUploadArtifactClass: (value: string) => void,
    setUploadImportance: (value: string) => void,
    setUploadMetadataJson: (value: string) => void,
    setUploadProjectId: (value: string) => void,
    setUploadCustomerId: (value: string) => void,
    setUploadTaskId: (value: string) => void
) {
    setUploadFile(null);
    setUploadTitle("");
    setUploadKind("report");
    setUploadArtifactClass(DEFAULT_ARTIFACT_CLASS);
    setUploadImportance(DEFAULT_ARTIFACT_IMPORTANCE);
    setUploadMetadataJson("{}");
    setUploadProjectId(projectId);
    setUploadCustomerId(customerId);
    setUploadTaskId("");
}

function findProjectCustomerId(projects: ProjectOption[], projectId: string) {
    if (!projectId) {
        return "";
    }
    return projects.find((project) => project.id === projectId)?.customerId || "";
}
