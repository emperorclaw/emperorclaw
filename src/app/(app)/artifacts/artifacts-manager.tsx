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
import {
    ArrowDownToLine,
    ChevronDown,
    ChevronRight,
    File,
    FileArchive,
    FileCode2,
    FileImage,
    FileJson2,
    FileSpreadsheet,
    FileText,
    Folder,
    FolderOpen,
    FolderPlus,
    Loader2,
    Maximize2,
    MoreHorizontal,
    PencilLine,
    Plus,
    RefreshCcw,
    Save,
    Search,
    Settings2,
    Trash2,
    Upload,
} from "lucide-react";
import { toast } from "sonner";
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
    | { state: "unsupported"; message: string };

const ROOT_ID = "root";

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

type Props = {
    projects: ProjectOption[];
    tasks: TaskOption[];
    customers: CustomerOption[];
};

export default function ArtifactsManager({ projects, tasks, customers }: Props) {
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
    const [csvEditorRows, setCsvEditorRows] = useState<string[][]>([]);
    const [csvRawDraft, setCsvRawDraft] = useState("");
    const [csvSourceText, setCsvSourceText] = useState("");
    const [csvRawError, setCsvRawError] = useState<string | null>(null);
    const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
    const [isInspectorOpen, setIsInspectorOpen] = useState(false);
    const [isUploadOpen, setIsUploadOpen] = useState(false);
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
    const deferredSearch = useDeferredValue(searchValue);

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
    const selectedFolder = selectedEntry?.type === "folder"
        ? findFolderById(folderCache, selectedEntry.id)
        : null;
    const knownFolders = buildKnownFolders(folderCache);
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
    const isCsvArtifact = preview.state === "csv";
    const isCsvDirty = normalizeTextForCompare(csvRawDraft) !== normalizeTextForCompare(csvSourceText);

    async function loadFolder(folderId: string, options?: { silent?: boolean }) {
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
                throw new Error(await readError(response, "Unable to fetch folder contents"));
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

    async function fetchArtifactDetail(artifactId: string) {
        const response = await fetch(`/api/ui/artifacts/${artifactId}`, {
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error(await readError(response, "Unable to fetch file details"));
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
                throw new Error(await readError(response, "Unable to search storage"));
            }
            const payload = await response.json() as { artifacts: ArtifactSummary[] };
            setGlobalArtifacts(payload.artifacts);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to search storage");
        } finally {
            setIsSearchLoading(false);
        }
    }

    useEffect(() => {
        void loadFolder(ROOT_ID);
    }, []);

    useEffect(() => {
        if (!folderCache[currentFolderId]) {
            void loadFolder(currentFolderId);
        }
    }, [currentFolderId, folderCache]);

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
                message: error instanceof Error ? error.message : "Unable to fetch file details",
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
    }, [artifactDetail?.id, preview.state === "csv" ? preview.text : ""]);

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

                if (previewMode === "image" || previewMode === "pdf") {
                    const blob = await fetchArtifactBlob(activeArtifact.id);
                    if (previewRequestRef.current !== requestId) {
                        return;
                    }
                    const objectUrl = URL.createObjectURL(blob);
                    previewUrlRef.current = objectUrl;
                    setPreview(previewMode === "image" ? { state: "image", url: objectUrl } : { state: "pdf", url: objectUrl });
                    return;
                }

                setPreview({
                    state: "unsupported",
                    message: `${activeArtifact.contentType} preview is not available yet.`,
                });
            } catch (error) {
                if (previewRequestRef.current === requestId) {
                    setPreview({
                        state: "error",
                        message: error instanceof Error ? error.message : "Unable to load preview",
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
            toast.error("Folder name is required");
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
                throw new Error(await readError(response, "Unable to create folder"));
            }
            const payload = await response.json() as { folder: FolderSummary };
            setIsCreateFolderOpen(false);
            setSelectedEntry({ type: "folder", id: payload.folder.id });
            setCurrentFolderId(payload.folder.id);
            await reloadWorkspace(payload.folder.id);
            toast.success("Folder created");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to create folder");
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
                throw new Error(await readError(response, "Unable to save folder"));
            }
            await reloadWorkspace(selectedFolder.id);
            toast.success("Folder updated");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to save folder");
        } finally {
            setIsSavingFolder(false);
        }
    }

    async function handleDeleteFolder(folderId: string) {
        if (!window.confirm("Delete this folder and hide everything inside it?")) {
            return;
        }

        try {
            const response = await fetch(`/api/ui/folders/${folderId}`, {
                method: "DELETE",
            });
            if (!response.ok) {
                throw new Error(await readError(response, "Unable to delete folder"));
            }
            setSelectedEntry({ type: "folder", id: currentFolderId });
            await reloadWorkspace(currentFolderId);
            toast.success("Folder deleted");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to delete folder");
        }
    }

    async function handleUpload() {
        if (!uploadFile) {
            toast.error("Choose a file to upload");
            return;
        }
        if (!uploadProjectId && !uploadCustomerId) {
            toast.error("Choose a customer or project");
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
                throw new Error(await readError(response, "Unable to upload file"));
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
            toast.success("File uploaded");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to upload file");
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
                throw new Error(await readError(response, "Unable to save file properties"));
            }
            await fetchArtifactDetail(artifactDetail.id);
            if (isSearchMode) {
                await fetchSearchResults();
            } else {
                await reloadWorkspace(currentFolderId);
            }
            toast.success("File properties updated");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to save file properties");
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
                throw new Error(await readError(response, "Unable to move file"));
            }
            await fetchArtifactDetail(artifactDetail.id);
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success("File location updated");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to move file");
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
                throw new Error(await readError(response, "Unable to replace file"));
            }
            await fetchArtifactDetail(artifactDetail.id);
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success("File content replaced");
            return true;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to replace file");
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
            toast.success("CSV grid refreshed");
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to parse CSV";
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

    async function handleDeleteArtifact(artifactId: string) {
        if (!window.confirm("Delete this file from storage?")) {
            return;
        }

        try {
            const response = await fetch(`/api/ui/artifacts/${artifactId}/delete`, {
                method: "DELETE",
            });
            if (!response.ok) {
                throw new Error(await readError(response, "Unable to delete file"));
            }
            setSelectedEntry({ type: "folder", id: currentFolderId });
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success("File deleted");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to delete file");
        }
    }

    function handleDownloadArtifact(artifactId: string) {
        window.open(`/api/ui/artifacts/${artifactId}/download`, "_blank", "noopener,noreferrer");
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
                {!isRootFolder && <ContextMenuItem onClick={() => openFolder(folder.id)}>Open</ContextMenuItem>}
                <ContextMenuItem onClick={() => {
                    setSelectedEntry({ type: "folder", id: folder.id });
                    beginCreateFolderAt({
                        id: folder.id,
                        projectId: folder.projectId ?? null,
                        customerId: folder.customerId ?? null,
                    });
                }}>
                    New Folder Here
                </ContextMenuItem>
                {!isRootFolder && (
                    <>
                        <ContextMenuItem onClick={() => {
                            setSelectedEntry({ type: "folder", id: folder.id });
                            setInspectorTab("properties");
                        }}>
                            Edit Properties
                        </ContextMenuItem>
                        <ContextMenuItem variant="destructive" onClick={() => void handleDeleteFolder(folder.id)}>
                            Delete Folder
                        </ContextMenuItem>
                    </>
                )}
            </>
        );
    }

    function renderArtifactMenu(artifact: ArtifactSummary) {
        return (
            <>
                <ContextMenuItem onClick={() => {
                    setSelectedEntry({ type: "artifact", id: artifact.id });
                    setInspectorTab("preview");
                }}>
                    Preview
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleDownloadArtifact(artifact.id)}>Download</ContextMenuItem>
                <ContextMenuItem onClick={() => {
                    setSelectedEntry({ type: "artifact", id: artifact.id });
                    setInspectorTab("properties");
                }}>
                    Edit Properties
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" onClick={() => void handleDeleteArtifact(artifact.id)}>
                    Delete File
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

    function clearFilters() {
        setSearchValue("");
        setProjectFilter("");
        setTaskFilter("");
        setCustomerFilter("");
        setKindFilter("");
    }

    const breadcrumbItems = currentContents
        ? [{ id: ROOT_ID, name: "Root", path: "" }, ...currentContents.ancestors, currentContents.folder.id === ROOT_ID ? null : currentContents.folder].filter(Boolean) as Array<Pick<FolderSummary, "id" | "name" | "path">>
        : [{ id: ROOT_ID, name: "Root", path: "" }];

    return (
        <div className="flex h-full flex-col gap-6">
            <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">Storage</p>
                        <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Files and deliverables</h1>
                        <p className="max-w-3xl text-sm text-zinc-400">
                            Browse durable outputs, proofs, working files, and uploads. Emperor indexes the metadata so agents can find the right file later.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={() => void reloadWorkspace()} className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900">
                            <RefreshCcw className="size-4" />
                            Refresh
                        </Button>
                        <Button variant="outline" onClick={beginCreateFolder} className="border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900">
                            <FolderPlus className="size-4" />
                            New Folder
                        </Button>
                        <Button onClick={beginUpload} className="bg-zinc-100 text-zinc-950 hover:bg-zinc-200">
                            <Upload className="size-4" />
                            Upload
                        </Button>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-950/80 px-4 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
                    <div className="relative min-w-[240px] flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                        <Input
                            value={searchValue}
                            onChange={(event) => setSearchValue(event.target.value)}
                            placeholder="Search files, names, or paths"
                            className="border-zinc-800 bg-zinc-900 pl-9 text-zinc-100"
                        />
                    </div>
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
                        className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">All projects</option>
                        {projects.map((project) => (
                            <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                    </select>
                    <select
                        value={taskFilter}
                        onChange={(event) => setTaskFilter(event.target.value)}
                        className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">All tasks</option>
                        {tasks.filter((task) => !projectFilter || task.projectId === projectFilter).map((task) => (
                            <option key={task.id} value={task.id}>{task.type}</option>
                        ))}
                    </select>
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
                        className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">All customers</option>
                        {customers.map((customer) => (
                            <option key={customer.id} value={customer.id}>{customer.name}</option>
                        ))}
                    </select>
                    <select
                        value={kindFilter}
                        onChange={(event) => setKindFilter(event.target.value)}
                        className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">All kinds</option>
                        <option value="report">report</option>
                        <option value="invoice">invoice</option>
                        <option value="statement">statement</option>
                        <option value="document">document</option>
                        <option value="export">export</option>
                    </select>
                    {hasActiveFilters && (
                        <Button
                            variant="outline"
                            onClick={clearFilters}
                            className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                        >
                            Clear
                        </Button>
                    )}
                </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_1fr]">
                <Card className="min-h-0 border-zinc-800/80 bg-zinc-950/70 py-0">
                    <CardHeader className="border-b border-zinc-800/80 py-4">
                        <CardTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">Folders</CardTitle>
                    </CardHeader>
                    <CardContent className="min-h-0 px-0">
                        <ScrollArea className="h-[calc(100vh-18rem)]">
                            <div className="space-y-1 px-3 py-3">
                                <TreeFolderRow
                                    folder={{ id: ROOT_ID, name: "Root", path: "", projectId: null, customerId: null }}
                                    depth={0}
                                    isExpanded={expandedFolders[ROOT_ID] ?? true}
                                    isSelected={selectedEntry?.type === "folder" && selectedEntry.id === ROOT_ID}
                                    onToggle={() => toggleFolder(ROOT_ID)}
                                    onOpen={() => openFolder(ROOT_ID)}
                                    onContextMenu={() => setSelectedEntry({ type: "folder", id: ROOT_ID })}
                                    contextMenuContent={renderFolderMenu({ id: ROOT_ID, name: "Root", path: "", projectId: null, customerId: null })}
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
                                            {index < breadcrumbItems.length - 1 && <ChevronRight className="size-3 text-zinc-600" />}
                                        </div>
                                    ))}
                                </div>
                                <CardTitle className="text-xl text-zinc-100">
                                    {isSearchMode ? "Search results" : currentContents?.folder.name || "Root"}
                                </CardTitle>
                            </div>
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                                    {visibleFolders.length} folders
                                </Badge>
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                                    {visibleArtifacts.length} files
                                </Badge>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="min-h-0 px-0">
                        <div className="grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_120px_140px_80px] border-b border-zinc-800/80 px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                            <span>Name</span>
                            <span>Context</span>
                            <span>Size</span>
                            <span>Updated</span>
                            <span />
                        </div>
                        <ScrollArea className="h-[calc(100vh-18rem)]">
                            <div className="px-2 py-2">
                                {!isSearchMode && visibleFolders.map((folder) => (
                                    <BrowserRow
                                        key={folder.id}
                                        icon={<Folder className="size-4 text-amber-300" />}
                                        title={folder.name}
                                        subtitle={folder.path || "Root"}
                                        context={folder.projectId ? projects.find((project) => project.id === folder.projectId)?.name || "Scoped folder" : "Folder"}
                                        sizeLabel="Folder"
                                        dateLabel={formatRelativeDate(folder.createdAt)}
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
                                                        <MoreHorizontal className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                                                    <DropdownMenuItem onClick={() => openFolder(folder.id)}>Open</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => {
                                                        setSelectedEntry({ type: "folder", id: folder.id });
                                                        beginCreateFolderAt(folder);
                                                    }}>New Folder Here</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "folder", id: folder.id }); setInspectorTab("properties"); setIsInspectorOpen(true); }}>Edit Properties</DropdownMenuItem>
                                                    <DropdownMenuItem variant="destructive" onClick={() => void handleDeleteFolder(folder.id)}>Delete Folder</DropdownMenuItem>
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
                                        dateLabel={formatRelativeDate(artifact.updatedAt || artifact.createdAt)}
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
                                                        <MoreHorizontal className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("preview"); setIsInspectorOpen(true); }}>Preview</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => handleDownloadArtifact(artifact.id)}>Download</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("properties"); setIsInspectorOpen(true); }}>Edit Properties</DropdownMenuItem>
                                                    <DropdownMenuItem variant="destructive" onClick={() => void handleDeleteArtifact(artifact.id)}>Delete File</DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        )}
                                    />
                                ))}
                                {loadingFolderId === currentFolderId && !isSearchMode && (
                                    <div className="flex items-center gap-2 px-4 py-6 text-sm text-zinc-400">
                                        <Loader2 className="size-4 animate-spin" />
                                        Loading folder contents...
                                    </div>
                                )}
                                {isSearchLoading && isSearchMode && (
                                    <div className="flex items-center gap-2 px-4 py-6 text-sm text-zinc-400">
                                        <Loader2 className="size-4 animate-spin" />
                                        Searching storage...
                                    </div>
                                )}
                                {!loadingFolderId && !isSearchLoading && visibleFolders.length === 0 && visibleArtifacts.length === 0 && (
                                    <div className="mx-2 mt-2 rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/80 px-6 py-14 text-center">
                                        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                                            <FolderOpen className="size-6 text-zinc-500" />
                                        </div>
                                        <h3 className="text-lg font-medium text-zinc-100">Nothing here yet</h3>
                                        <p className="mt-2 text-sm text-zinc-400">
                                            Create a folder, upload a file, or broaden the current filters.
                                        </p>
                                    </div>
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
            />

            <Dialog open={isInspectorOpen} onOpenChange={setIsInspectorOpen}>
                <DialogContent className="max-h-[92vh] w-[95vw] overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-4xl lg:max-w-6xl xl:max-w-[1200px]">
                    <div className="flex h-[calc(100vh-4rem)] min-h-[500px] flex-col">
                        <DialogHeader className="flex flex-row items-center justify-between border-b border-zinc-800 px-6 py-4">
                            <DialogTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">Inspector</DialogTitle>
                            {selectedEntry?.type === "artifact" && (
                                <Button variant="ghost" size="icon-sm" onClick={() => setInspectorTab(inspectorTab === "preview" ? "properties" : "preview")} className="text-zinc-400 hover:text-zinc-100 mt-0!">
                                    <Settings2 className="size-4" />
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
                                        onDelete={() => void handleDeleteFolder(selectedFolder.id)}
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
                                        onDownload={() => handleDownloadArtifact(artifactDetail.id)}
                                        onDelete={() => void handleDeleteArtifact(artifactDetail.id)}
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
                {props.isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </span>
            <Folder className="size-4 shrink-0 text-amber-300" />
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
                "grid cursor-default grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_120px_140px_80px] items-center rounded-xl px-2 py-1.5 transition",
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
            <div className="truncate px-2 text-sm text-zinc-400">{props.context}</div>
            <div className="px-2 text-sm text-zinc-400">{props.sizeLabel}</div>
            <div className="px-2 text-sm text-zinc-400">{props.dateLabel}</div>
            <div className="flex items-center justify-end">
                {props.onInspect && (
                    <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); props.onInspect?.(); }} className="text-zinc-400 hover:text-zinc-100">
                        <Maximize2 className="size-4" />
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
    if (props.folder.id === ROOT_ID) {
        return (
            <div className="space-y-4">
                <div className="flex items-start gap-3">
                    <div className="flex size-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                        <Folder className="size-6 text-amber-300" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-zinc-100">Root</h2>
                        <p className="text-sm text-zinc-400">Top-level folder container</p>
                    </div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 text-sm text-zinc-400">
                    Root is the top-level container for all storage folders.
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <div className="flex items-start gap-3">
                <div className="flex size-12 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
                    <Folder className="size-6 text-amber-300" />
                </div>
                <div>
                    <h2 className="text-lg font-semibold text-zinc-100">{props.folder.name}</h2>
                    <p className="text-sm text-zinc-400">{props.folder.path || "Root folder"}</p>
                </div>
            </div>
            <div className="space-y-4">
                <Field label="Folder name">
                    <Input
                        value={props.draft.name}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, name: event.target.value }))}
                        className="border-zinc-800 bg-zinc-900 text-zinc-100"
                    />
                </Field>
                <Field label="Parent folder">
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
                <Field label="Project">
                    <select
                        value={props.draft.projectId}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, projectId: event.target.value }))}
                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">None</option>
                        {props.projects.map((project) => (
                            <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                    </select>
                </Field>
                <Field label="Customer">
                    <select
                        value={props.draft.customerId}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, customerId: event.target.value }))}
                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                    >
                        <option value="">None</option>
                        {props.customers.map((customer) => (
                            <option key={customer.id} value={customer.id}>{customer.name}</option>
                        ))}
                    </select>
                </Field>
                <Field label="Metadata JSON">
                    <Textarea
                        value={props.draft.metadataJson}
                        onChange={(event) => props.onDraftChange((current) => ({ ...current, metadataJson: event.target.value }))}
                        className="min-h-36 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100"
                    />
                </Field>
                <div className="flex flex-wrap gap-2">
                    <Button onClick={props.onSave} disabled={props.isSaving || !props.hasChanges}>
                        {props.isSaving && <Loader2 className="size-4 animate-spin" />}
                        Save Folder
                    </Button>
                    <Button variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20" onClick={props.onDelete}>
                        <Trash2 className="size-4" />
                        Delete
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
    onDownload: () => void;
    onDelete: () => void;
    onOpenLargePreview: () => void;
}) {
    return (
        <Tabs value={props.inspectorTab} onValueChange={props.onInspectorTabChange}>
            <TabsList variant="line" className="mb-4 border-b border-zinc-800 pb-1">
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="properties">Properties</TabsTrigger>
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
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">{getArtifactClassLabel(props.artifact.artifactClass)}</Badge>
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">{getArtifactImportanceLabel(props.artifact.importance)}</Badge>
                                <Badge variant="outline" className="border-zinc-700 text-zinc-300">{props.artifact.contentType}</Badge>
                                {props.artifact.isCanonical && <Badge className="bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/15">canonical</Badge>}
                            </div>
                        </div>
                    </div>
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4">
                        <PreviewPanel preview={props.preview} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onDownload}>
                            <ArrowDownToLine className="size-4" />
                            Download
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onOpenLargePreview}>
                            <Maximize2 className="size-4" />
                            {props.preview.state === "csv" ? "Open CSV Workspace" : "Open Large View"}
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onReplace}>
                            <PencilLine className="size-4" />
                            Replace Content
                        </Button>
                    </div>
                </div>
            </TabsContent>
            <TabsContent value="properties">
                <div className="space-y-4">
                    <Field label="Title">
                        <Input
                            value={props.draft.title}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, title: event.target.value }))}
                            className="border-zinc-800 bg-zinc-900 text-zinc-100"
                        />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Kind">
                            <Input
                                value={props.draft.kind}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, kind: event.target.value }))}
                                className="border-zinc-800 bg-zinc-900 text-zinc-100"
                            />
                        </Field>
                        <Field label="Visibility">
                            <select
                                value={props.draft.visibility}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, visibility: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="private">private</option>
                                <option value="company">company</option>
                            </select>
                        </Field>
                        <Field label="Project">
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
                                <option value="">None</option>
                                {props.projects.map((project) => (
                                    <option key={project.id} value={project.id}>{project.name}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Task">
                            <select
                                value={props.draft.taskId}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, taskId: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                disabled={!props.draft.projectId}
                            >
                                <option value="">None</option>
                                {props.tasks.filter((task) => task.projectId === props.draft.projectId).map((task) => (
                                    <option key={task.id} value={task.id}>{task.type}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Customer">
                            <select
                                value={props.draft.customerId}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, customerId: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                disabled={Boolean(props.draft.projectId)}
                            >
                                <option value="">None</option>
                                {props.customers.map((customer) => (
                                    <option key={customer.id} value={customer.id}>{customer.name}</option>
                                ))}
                            </select>
                        </Field>
                    </div>
                    <details className="rounded-2xl border border-zinc-800 bg-zinc-950/80">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-zinc-300">
                            Classification & advanced
                        </summary>
                        <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                            <p className="text-xs text-zinc-500">
                                These fields are mostly filing hints for the system. Most users only need title, scope, location, and canonical state.
                            </p>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Field label="File role">
                                    <select
                                        value={props.draft.artifactClass}
                                        onChange={(event) => props.onDraftChange((current) => ({ ...current, artifactClass: event.target.value }))}
                                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                    >
                                        {ARTIFACT_CLASS_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </Field>
                                <Field label="Lifecycle">
                                    <select
                                        value={props.draft.importance}
                                        onChange={(event) => props.onDraftChange((current) => ({ ...current, importance: event.target.value }))}
                                        className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                    >
                                        {ARTIFACT_IMPORTANCE_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </Field>
                                <Field label="Retention policy">
                                    <Input
                                        value={props.draft.retentionPolicy}
                                        onChange={(event) => props.onDraftChange((current) => ({ ...current, retentionPolicy: event.target.value }))}
                                        className="border-zinc-800 bg-zinc-900 text-zinc-100"
                                    />
                                </Field>
                            </div>
                            <Field label="Metadata JSON">
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
                        Mark as canonical
                    </label>
                    <Field label="Filename">
                        <Input
                            value={props.locationDraft.name}
                            onChange={(event) => props.onLocationDraftChange((current) => ({ ...current, name: event.target.value }))}
                            className="border-zinc-800 bg-zinc-900 text-zinc-100"
                        />
                    </Field>
                    <Field label="Folder">
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
                        <InfoPill label="Path" value={props.artifact.path || "-"} />
                        <InfoPill label="SHA256" value={props.artifact.sha256 || "-"} mono />
                        <InfoPill label="Size" value={formatBytes(props.artifact.sizeBytes)} />
                        <InfoPill label="Updated" value={formatRelativeDate(props.artifact.updatedAt || props.artifact.createdAt)} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={props.onSaveProperties} disabled={props.isSavingArtifact || !props.hasPropertyChanges}>
                            {props.isSavingArtifact && <Loader2 className="size-4 animate-spin" />}
                            Save Properties
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onSaveLocation} disabled={props.isSavingLocation || !props.hasLocationChanges}>
                            {props.isSavingLocation && <Loader2 className="size-4 animate-spin" />}
                            Save Location
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onReplace}>
                            Replace Content
                        </Button>
                        <Button variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20" onClick={props.onDelete}>
                            <Trash2 className="size-4" />
                            Delete
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
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                <DialogHeader>
                    <DialogTitle>Create folder</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        Create a new folder inside the current location.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <Field label="Folder name">
                        <Input
                            value={props.draft.name}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, name: event.target.value }))}
                            className="border-zinc-800 bg-zinc-900 text-zinc-100"
                        />
                    </Field>
                    <Field label="Project">
                        <select
                            value={props.draft.projectId}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, projectId: event.target.value }))}
                            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                        >
                            <option value="">None</option>
                            {props.projects.map((project) => (
                                <option key={project.id} value={project.id}>{project.name}</option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Customer">
                        <select
                            value={props.draft.customerId}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, customerId: event.target.value }))}
                            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                        >
                            <option value="">None</option>
                            {props.customers.map((customer) => (
                                <option key={customer.id} value={customer.id}>{customer.name}</option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Metadata JSON">
                        <Textarea
                            value={props.draft.metadataJson}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, metadataJson: event.target.value }))}
                            className="min-h-28 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100"
                        />
                    </Field>
                </div>
                <DialogFooter>
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={() => props.onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={props.onSubmit} disabled={props.isSaving}>
                        {props.isSaving && <Loader2 className="size-4 animate-spin" />}
                        Create
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
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                <DialogHeader>
                    <DialogTitle>Upload file</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        Upload a file into the current folder. Customer is required; project is optional.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <Field label="File">
                        <Input type="file" onChange={props.onFileChange} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                    </Field>
                    <Field label="Title">
                        <Input value={props.uploadTitle} onChange={(event) => props.onTitleChange(event.target.value)} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Customer">
                            <select
                                value={props.uploadCustomerId}
                                onChange={(event) => props.onCustomerChange(event.target.value)}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                                disabled={Boolean(props.uploadProjectId)}
                            >
                                <option value="">Select customer</option>
                                {props.customers.map((customer) => (
                                    <option key={customer.id} value={customer.id}>{customer.name}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Project">
                            <select value={props.uploadProjectId} onChange={(event) => props.onProjectChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                <option value="">None</option>
                                {props.projects.map((project) => (
                                    <option key={project.id} value={project.id}>{project.name}</option>
                                ))}
                            </select>
                        </Field>
                    </div>
                    <details className="rounded-xl border border-zinc-800 bg-zinc-950/70">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-zinc-300">
                            Advanced
                        </summary>
                        <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                            <p className="text-xs text-zinc-500">
                                Defaults are usually right. Most uploads only need a title and the right project or customer scope.
                            </p>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Field label="Kind">
                                    <Input value={props.uploadKind} onChange={(event) => props.onKindChange(event.target.value)} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                                </Field>
                                <Field label="File role">
                                    <select value={props.uploadArtifactClass} onChange={(event) => props.onArtifactClassChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                        {ARTIFACT_CLASS_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </Field>
                                <Field label="Lifecycle">
                                    <select value={props.uploadImportance} onChange={(event) => props.onImportanceChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                        {ARTIFACT_IMPORTANCE_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </Field>
                            </div>
                            <Field label="Metadata JSON">
                                <Textarea value={props.uploadMetadataJson} onChange={(event) => props.onMetadataJsonChange(event.target.value)} className="min-h-28 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100" />
                            </Field>
                        </div>
                    </details>
                </div>
                <DialogFooter>
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={() => props.onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={props.onSubmit} disabled={props.isUploading}>
                        {props.isUploading && <Loader2 className="size-4 animate-spin" />}
                        Upload
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
    onCsvCellChange: (rowIndex: number, columnIndex: number, value: string) => void;
    onAddCsvRow: () => void;
    onDeleteCsvRow: (rowIndex: number) => void;
    onAddCsvColumn: () => void;
    onDeleteCsvColumn: (columnIndex: number) => void;
    onCsvRawDraftChange: (value: string) => void;
    onApplyRawCsvToGrid: () => void;
    onResetCsvDraft: () => void;
    onSaveCsvDraft: () => void;
}) {
    const isCsvPreview = props.preview.state === "csv";
    const title = props.artifact ? deriveDisplayName(props.artifact) : "File preview";

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="max-h-[92vh] overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-6xl">
                <div className="flex h-full max-h-[92vh] flex-col">
                    <DialogHeader className="border-b border-zinc-800 px-6 py-5">
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription className="text-zinc-400">
                            {isCsvPreview
                                ? "Review the file in a larger workspace and edit CSV content without leaving the storage panel."
                                : "Expanded preview for comfortable reading and verification."}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">
                        {isCsvPreview ? (
                            <Tabs value={props.activeTab} onValueChange={props.onTabChange} className="flex h-full min-h-0 flex-col">
                                <TabsList variant="line" className="mb-4 border-b border-zinc-800 pb-1">
                                    <TabsTrigger value="preview">Preview</TabsTrigger>
                                    <TabsTrigger value="table">Grid Editor</TabsTrigger>
                                    <TabsTrigger value="raw">Raw CSV</TabsTrigger>
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
                                                Edit the raw CSV directly when you need exact control over formatting or pasted data.
                                            </span>
                                            <Button
                                                variant="outline"
                                                className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                                                onClick={props.onApplyRawCsvToGrid}
                                            >
                                                Refresh Grid
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
                        ) : (
                            <div className="h-full overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
                                <PreviewPanel preview={props.preview} />
                            </div>
                        )}
                    </div>

                    <DialogFooter className="border-t border-zinc-800 px-6 py-4 sm:justify-between">
                        <div className="text-xs text-zinc-500">
                            {isCsvPreview
                                ? "Saving replaces the current CSV file while keeping the storage record."
                                : "Downloads and replacements still happen through the file actions."}
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
                                        <RefreshCcw className="size-4" />
                                        Reset
                                    </Button>
                                    <Button onClick={props.onSaveCsvDraft} disabled={props.isSavingCsv || !props.isCsvDirty}>
                                        {props.isSavingCsv ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                                        Save CSV
                                    </Button>
                                </>
                            )}
                            <Button
                                variant="outline"
                                className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                                onClick={() => props.onOpenChange(false)}
                            >
                                Close
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
    const columnCount = getCsvColumnCount(props.rows);

    return (
        <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-zinc-500">
                    Grid editing is best for quick corrections, column cleanup, and row-level fixes.
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onAddColumn}>
                        <Plus className="size-4" />
                        Add Column
                    </Button>
                    <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onAddRow}>
                        <Plus className="size-4" />
                        Add Row
                    </Button>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/80">
                <table className="min-w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                        <tr>
                            <th className="w-28 border-b border-r border-zinc-800 px-3 py-3 text-left text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                                Row
                            </th>
                            {Array.from({ length: columnCount }, (_, columnIndex) => (
                                <th key={`column-${columnIndex}`} className="min-w-52 border-b border-zinc-800 px-3 py-3 text-left">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                                            Column {columnIndex + 1}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            className="text-zinc-500 hover:text-zinc-100"
                                            onClick={() => props.onDeleteColumn(columnIndex)}
                                        >
                                            <Trash2 className="size-4" />
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
                                            {rowIndex === 0 ? "Header" : `Row ${rowIndex + 1}`}
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            className="text-zinc-500 hover:text-zinc-100"
                                            onClick={() => props.onDeleteRow(rowIndex)}
                                        >
                                            <Trash2 className="size-4" />
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
    if (preview.state === "idle" || preview.state === "loading") {
        return (
            <div className="flex min-h-80 items-center justify-center text-sm text-zinc-400">
                {preview.state === "loading" ? <><Loader2 className="mr-2 size-4 animate-spin" />Loading preview...</> : "Select a file to preview it."}
            </div>
        );
    }
    if (preview.state === "error") {
        return <div className="min-h-80 rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-200">{preview.message}</div>;
    }
    if (preview.state === "unsupported") {
        return <div className="min-h-80 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">{preview.message}</div>;
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
        return <img src={preview.url} alt="File preview" className="max-h-[32rem] w-full rounded-xl object-contain" />;
    }
    if (preview.state === "pdf") {
        return <iframe src={preview.url} title="PDF preview" className="h-[32rem] w-full rounded-xl border border-zinc-800 bg-white" />;
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
    return (
        <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/80 px-6 text-center">
            <Settings2 className="mb-4 size-8 text-zinc-600" />
            <h3 className="text-lg font-medium text-zinc-100">Select a file or folder</h3>
            <p className="mt-2 text-sm text-zinc-400">
                Preview file contents, edit metadata, rename items, and manage folder structure from this inspector.
            </p>
        </div>
    );
}

function renderArtifactIcon(artifact: Pick<ArtifactSummary, "contentType" | "originalFilename">) {
    const name = artifact.originalFilename?.toLowerCase() || "";
    const contentType = artifact.contentType.toLowerCase();

    if (contentType.includes("json") || name.endsWith(".json")) return <FileJson2 className="size-4 text-sky-300" />;
    if (contentType.includes("csv") || name.endsWith(".csv") || name.endsWith(".xlsx") || name.endsWith(".xls")) return <FileSpreadsheet className="size-4 text-emerald-300" />;
    if (contentType.includes("markdown") || name.endsWith(".md")) return <FileCode2 className="size-4 text-indigo-300" />;
    if (contentType.includes("image/")) return <FileImage className="size-4 text-rose-300" />;
    if (contentType.includes("pdf") || name.endsWith(".pdf")) return <FileText className="size-4 text-red-300" />;
    if (name.endsWith(".zip") || name.endsWith(".tar") || name.endsWith(".gz")) return <FileArchive className="size-4 text-amber-300" />;
    if (contentType.startsWith("text/")) return <FileText className="size-4 text-zinc-300" />;
    return <File className="size-4 text-zinc-300" />;
}

function buildArtifactContextLabel(artifact: ArtifactSummary) {
    return [artifact.projectGoal, artifact.taskType, artifact.customerName].filter(Boolean).join(" · ") || artifact.kind;
}

function deriveDisplayName(artifact: Pick<ArtifactSummary, "title" | "originalFilename" | "path" | "kind">) {
    return artifact.originalFilename || artifact.title || artifact.path?.split("/").pop() || artifact.kind;
}

function buildKnownFolders(cache: Record<string, FolderContentsResponse>) {
    const folders = new Map<string, { id: string; pathLabel: string }>();
    folders.set(ROOT_ID, { id: ROOT_ID, pathLabel: "Root" });
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

function formatRelativeDate(value?: string) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
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
