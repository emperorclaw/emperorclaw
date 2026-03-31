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
    MoreHorizontal,
    PencilLine,
    RefreshCcw,
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ProjectOption = {
    id: string;
    name: string;
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
    | { state: "csv"; rows: string[][] }
    | { state: "image"; url: string }
    | { state: "pdf"; url: string }
    | { state: "unsupported"; message: string };

const ROOT_ID = "root";

const DEFAULT_ARTIFACT_DRAFT: ArtifactDraft = {
    title: "",
    kind: "report",
    artifactClass: "working_file",
    importance: "operational",
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
    const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
    const [isUploadOpen, setIsUploadOpen] = useState(false);
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploadTitle, setUploadTitle] = useState("");
    const [uploadKind, setUploadKind] = useState("report");
    const [uploadArtifactClass, setUploadArtifactClass] = useState("working_file");
    const [uploadImportance, setUploadImportance] = useState("operational");
    const [uploadProjectId, setUploadProjectId] = useState(projects[0]?.id ?? "");
    const [uploadTaskId, setUploadTaskId] = useState("");
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

    const visibleFolders = isSearchMode ? [] : currentContents?.folders ?? [];
    const visibleArtifacts = isSearchMode ? globalArtifacts : currentContents?.artifacts ?? [];
    const selectedFolder = selectedEntry?.type === "folder"
        ? findFolderById(folderCache, selectedEntry.id)
        : null;
    const knownFolders = buildKnownFolders(folderCache);
    const availableTasks = tasks.filter((task) => !uploadProjectId || task.projectId === uploadProjectId);

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
            throw new Error(await readError(response, "Unable to fetch artifact details"));
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
                throw new Error(await readError(response, "Unable to search artifacts"));
            }
            const payload = await response.json() as { artifacts: ArtifactSummary[] };
            setGlobalArtifacts(payload.artifacts);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to search artifacts");
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
                message: error instanceof Error ? error.message : "Unable to fetch artifact details",
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
                        setPreview({ state: "csv", rows: parseCsvPreview(text) });
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
                    parentFolderId: currentFolderId === ROOT_ID ? null : currentFolderId,
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
        if (!uploadProjectId || !uploadTaskId) {
            toast.error("Project and task are required");
            return;
        }

        setIsUploading(true);
        try {
            const formData = new FormData();
            formData.set("file", uploadFile);
            formData.set("projectId", uploadProjectId);
            formData.set("taskId", uploadTaskId);
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
                throw new Error(await readError(response, "Unable to upload artifact"));
            }
            const payload = await response.json() as { artifact: ArtifactSummary };
            setIsUploadOpen(false);
            resetUploadState(
                payload.artifact.projectId ?? uploadProjectId,
                tasks,
                setUploadFile,
                setUploadTitle,
                setUploadKind,
                setUploadArtifactClass,
                setUploadImportance,
                setUploadMetadataJson,
                setUploadTaskId
            );
            setSelectedEntry({ type: "artifact", id: payload.artifact.id });
            await reloadWorkspace(currentFolderId);
            toast.success("Artifact uploaded");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to upload artifact");
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
                    projectId: artifactDraft.projectId,
                    taskId: artifactDraft.taskId,
                    customerId: artifactDraft.customerId || null,
                    isCanonical: artifactDraft.isCanonical,
                    metadataJson: parseJsonInput(artifactDraft.metadataJson),
                }),
            });
            if (!response.ok) {
                throw new Error(await readError(response, "Unable to save artifact properties"));
            }
            await fetchArtifactDetail(artifactDetail.id);
            if (isSearchMode) {
                await fetchSearchResults();
            } else {
                await reloadWorkspace(currentFolderId);
            }
            toast.success("Artifact properties updated");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to save artifact properties");
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
                throw new Error(await readError(response, "Unable to move artifact"));
            }
            await fetchArtifactDetail(artifactDetail.id);
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success("Artifact location updated");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to move artifact");
        } finally {
            setIsSavingLocation(false);
        }
    }

    async function handleReplaceArtifact(file: File) {
        if (!artifactDetail) {
            return;
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
                throw new Error(await readError(response, "Unable to replace artifact"));
            }
            await fetchArtifactDetail(artifactDetail.id);
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success("Artifact content replaced");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to replace artifact");
        } finally {
            setIsSavingArtifact(false);
        }
    }

    async function handleDeleteArtifact(artifactId: string) {
        if (!window.confirm("Delete this artifact?")) {
            return;
        }

        try {
            const response = await fetch(`/api/ui/artifacts/${artifactId}/delete`, {
                method: "DELETE",
            });
            if (!response.ok) {
                throw new Error(await readError(response, "Unable to delete artifact"));
            }
            setSelectedEntry({ type: "folder", id: currentFolderId });
            await reloadWorkspace(currentFolderId);
            if (isSearchMode) {
                await fetchSearchResults();
            }
            toast.success("Artifact deleted");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to delete artifact");
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

    function beginUpload() {
        const defaultProjectId = projectFilter || currentContents?.folder.projectId || projects[0]?.id || "";
        const candidateTask = tasks.find((task) => task.projectId === defaultProjectId);
        setUploadProjectId(defaultProjectId);
        setUploadTaskId(taskFilter || candidateTask?.id || "");
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

    const breadcrumbItems = currentContents
        ? [{ id: ROOT_ID, name: "Root", path: "" }, ...currentContents.ancestors, currentContents.folder.id === ROOT_ID ? null : currentContents.folder].filter(Boolean) as Array<Pick<FolderSummary, "id" | "name" | "path">>
        : [{ id: ROOT_ID, name: "Root", path: "" }];

    return (
        <div className="flex h-full flex-col gap-6">
            <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">Artifacts Workspace</p>
                        <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Bunny-backed file manager</h1>
                        <p className="max-w-3xl text-sm text-zinc-400">
                            Browse durable outputs as folders and files, preview supported formats, and edit the metadata that Emperor indexes.
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
                        onChange={(event) => setCustomerFilter(event.target.value)}
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
                </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[280px_minmax(0,1.5fr)_420px]">
                <Card className="min-h-0 border-zinc-800/80 bg-zinc-950/70 py-0">
                    <CardHeader className="border-b border-zinc-800/80 py-4">
                        <CardTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">Folders</CardTitle>
                    </CardHeader>
                    <CardContent className="min-h-0 px-0">
                        <ScrollArea className="h-[calc(100vh-18rem)]">
                            <div className="space-y-1 px-3 py-3">
                                <TreeFolderRow
                                    folder={{ id: ROOT_ID, name: "Root", path: "" }}
                                    depth={0}
                                    isExpanded={expandedFolders[ROOT_ID] ?? true}
                                    isSelected={selectedEntry?.type === "folder" && selectedEntry.id === ROOT_ID}
                                    onToggle={() => toggleFolder(ROOT_ID)}
                                    onOpen={() => openFolder(ROOT_ID)}
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
                        <div className="grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_120px_140px_52px] border-b border-zinc-800/80 px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
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
                                        actions={(
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon-sm" className="text-zinc-400 hover:text-zinc-100">
                                                        <MoreHorizontal className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                                                    <DropdownMenuItem onClick={() => openFolder(folder.id)}>Open</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "folder", id: folder.id }); setInspectorTab("properties"); }}>Edit Properties</DropdownMenuItem>
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
                                        onDoubleClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("preview"); }}
                                        actions={(
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button variant="ghost" size="icon-sm" className="text-zinc-400 hover:text-zinc-100">
                                                        <MoreHorizontal className="size-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("preview"); }}>Preview</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => handleDownloadArtifact(artifact.id)}>Download</DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => { setSelectedEntry({ type: "artifact", id: artifact.id }); setInspectorTab("properties"); }}>Edit Properties</DropdownMenuItem>
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
                                        Searching artifacts...
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

                <Card className="min-h-0 border-zinc-800/80 bg-zinc-950/70 py-0">
                    <CardHeader className="border-b border-zinc-800/80 py-4">
                        <div className="flex items-center justify-between gap-3">
                            <CardTitle className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400">Inspector</CardTitle>
                            {selectedEntry?.type === "artifact" && (
                                <Button variant="ghost" size="icon-sm" onClick={() => setInspectorTab(inspectorTab === "preview" ? "properties" : "preview")} className="text-zinc-400">
                                    <Settings2 className="size-4" />
                                </Button>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent className="min-h-0 px-0">
                        <ScrollArea className="h-[calc(100vh-18rem)]">
                            <div className="px-4 py-4">
                                {!selectedEntry && <EmptyInspector />}
                                {selectedEntry?.type === "folder" && selectedFolder && (
                                    <FolderInspector
                                        folder={selectedFolder}
                                        draft={folderDraft}
                                        knownFolders={knownFolders}
                                        projects={projects}
                                        customers={customers}
                                        isSaving={isSavingFolder}
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
                                        onInspectorTabChange={setInspectorTab}
                                        onDraftChange={setArtifactDraft}
                                        onLocationDraftChange={setArtifactLocationDraft}
                                        onSaveProperties={() => void handleSaveArtifactProperties()}
                                        onSaveLocation={() => void handleSaveArtifactLocation()}
                                        onReplace={() => replaceInputRef.current?.click()}
                                        onDownload={() => handleDownloadArtifact(artifactDetail.id)}
                                        onDelete={() => void handleDeleteArtifact(artifactDetail.id)}
                                    />
                                )}
                            </div>
                        </ScrollArea>
                    </CardContent>
                </Card>
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
                uploadMetadataJson={uploadMetadataJson}
                projects={projects}
                tasks={availableTasks}
                isUploading={isUploading}
                onOpenChange={setIsUploadOpen}
                onFileChange={handleUploadFileChange}
                onTitleChange={setUploadTitle}
                onKindChange={setUploadKind}
                onArtifactClassChange={setUploadArtifactClass}
                onImportanceChange={setUploadImportance}
                onProjectChange={(nextProjectId) => {
                    const candidateTask = tasks.find((task) => task.projectId === nextProjectId);
                    setUploadProjectId(nextProjectId);
                    setUploadTaskId(candidateTask?.id || "");
                }}
                onTaskChange={setUploadTaskId}
                onMetadataJsonChange={setUploadMetadataJson}
                onSubmit={() => void handleUpload()}
            />

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
                />
            ))}
        </div>
    );
}

function TreeFolderRow(props: {
    folder: Pick<FolderSummary, "id" | "name" | "path">;
    depth: number;
    isExpanded: boolean;
    isSelected: boolean;
    onToggle: () => void;
    onOpen: () => void;
}) {
    return (
        <button
            type="button"
            onClick={props.onOpen}
            className={cn(
                "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition",
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
            <span className="truncate">{props.folder.name}</span>
        </button>
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
    actions: ReactNode;
}) {
    return (
        <div
            onClick={props.onClick}
            onDoubleClick={props.onDoubleClick}
            className={cn(
                "grid cursor-default grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_120px_140px_52px] items-center rounded-xl px-2 py-1.5 transition",
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
            <div className="flex items-center justify-end">{props.actions}</div>
        </div>
    );
}

function FolderInspector(props: {
    folder: FolderSummary;
    draft: FolderDraft;
    knownFolders: Array<{ id: string; pathLabel: string }>;
    projects: ProjectOption[];
    customers: CustomerOption[];
    isSaving: boolean;
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
                    Root is the top-level container for all artifact folders.
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
                    <Button onClick={props.onSave} disabled={props.isSaving}>
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
    onInspectorTabChange: (value: string) => void;
    onDraftChange: Dispatch<SetStateAction<ArtifactDraft>>;
    onLocationDraftChange: Dispatch<SetStateAction<ArtifactLocationDraft>>;
    onSaveProperties: () => void;
    onSaveLocation: () => void;
    onReplace: () => void;
    onDownload: () => void;
    onDelete: () => void;
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
                        <Field label="Artifact class">
                            <select
                                value={props.draft.artifactClass}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, artifactClass: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="source_document">source_document</option>
                                <option value="working_file">working_file</option>
                                <option value="proof">proof</option>
                                <option value="deliverable">deliverable</option>
                                <option value="template">template</option>
                                <option value="export_bundle">export_bundle</option>
                            </select>
                        </Field>
                        <Field label="Importance">
                            <select
                                value={props.draft.importance}
                                onChange={(event) => props.onDraftChange((current) => ({ ...current, importance: event.target.value }))}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
                                <option value="temporary">temporary</option>
                                <option value="operational">operational</option>
                                <option value="record">record</option>
                                <option value="canonical">canonical</option>
                            </select>
                        </Field>
                        <Field label="Project">
                            <select
                                value={props.draft.projectId}
                                onChange={(event) => {
                                    const nextProjectId = event.target.value;
                                    const candidateTask = props.tasks.find((task) => task.projectId === nextProjectId);
                                    props.onDraftChange((current) => ({
                                        ...current,
                                        projectId: nextProjectId,
                                        taskId: candidateTask?.id ?? "",
                                    }));
                                }}
                                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200"
                            >
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
                            >
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
                            >
                                <option value="">None</option>
                                {props.customers.map((customer) => (
                                    <option key={customer.id} value={customer.id}>{customer.name}</option>
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
                    <Field label="Metadata JSON">
                        <Textarea
                            value={props.draft.metadataJson}
                            onChange={(event) => props.onDraftChange((current) => ({ ...current, metadataJson: event.target.value }))}
                            className="min-h-40 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100"
                        />
                    </Field>
                    <div className="grid gap-3 text-xs text-zinc-400 sm:grid-cols-2">
                        <InfoPill label="Path" value={props.artifact.path || "-"} />
                        <InfoPill label="SHA256" value={props.artifact.sha256 || "-"} mono />
                        <InfoPill label="Size" value={formatBytes(props.artifact.sizeBytes)} />
                        <InfoPill label="Updated" value={formatRelativeDate(props.artifact.updatedAt || props.artifact.createdAt)} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={props.onSaveProperties} disabled={props.isSavingArtifact}>
                            {props.isSavingArtifact && <Loader2 className="size-4 animate-spin" />}
                            Save Properties
                        </Button>
                        <Button variant="outline" className="border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800" onClick={props.onSaveLocation} disabled={props.isSavingLocation}>
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
    uploadMetadataJson: string;
    projects: ProjectOption[];
    tasks: TaskOption[];
    isUploading: boolean;
    onOpenChange: (open: boolean) => void;
    onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onTitleChange: (value: string) => void;
    onKindChange: (value: string) => void;
    onArtifactClassChange: (value: string) => void;
    onImportanceChange: (value: string) => void;
    onProjectChange: (value: string) => void;
    onTaskChange: (value: string) => void;
    onMetadataJsonChange: (value: string) => void;
    onSubmit: () => void;
}) {
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                <DialogHeader>
                    <DialogTitle>Upload artifact</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        Upload a file into the current folder and register its metadata in Emperor.
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
                        <Field label="Project">
                            <select value={props.uploadProjectId} onChange={(event) => props.onProjectChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                {props.projects.map((project) => (
                                    <option key={project.id} value={project.id}>{project.name}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Task">
                            <select value={props.uploadTaskId} onChange={(event) => props.onTaskChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                {props.tasks.map((task) => (
                                    <option key={task.id} value={task.id}>{task.type}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Kind">
                            <Input value={props.uploadKind} onChange={(event) => props.onKindChange(event.target.value)} className="border-zinc-800 bg-zinc-900 text-zinc-100" />
                        </Field>
                        <Field label="Artifact class">
                            <select value={props.uploadArtifactClass} onChange={(event) => props.onArtifactClassChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                <option value="source_document">source_document</option>
                                <option value="working_file">working_file</option>
                                <option value="proof">proof</option>
                                <option value="deliverable">deliverable</option>
                                <option value="template">template</option>
                                <option value="export_bundle">export_bundle</option>
                            </select>
                        </Field>
                        <Field label="Importance">
                            <select value={props.uploadImportance} onChange={(event) => props.onImportanceChange(event.target.value)} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200">
                                <option value="temporary">temporary</option>
                                <option value="operational">operational</option>
                                <option value="record">record</option>
                                <option value="canonical">canonical</option>
                            </select>
                        </Field>
                    </div>
                    <Field label="Metadata JSON">
                        <Textarea value={props.uploadMetadataJson} onChange={(event) => props.onMetadataJsonChange(event.target.value)} className="min-h-28 border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-100" />
                    </Field>
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
        return <img src={preview.url} alt="Artifact preview" className="max-h-[32rem] w-full rounded-xl object-contain" />;
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
    return value
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 25)
        .map((line) => line.split(",").map((cell) => cell.trim()));
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
    tasks: TaskOption[],
    setUploadFile: (value: File | null) => void,
    setUploadTitle: (value: string) => void,
    setUploadKind: (value: string) => void,
    setUploadArtifactClass: (value: string) => void,
    setUploadImportance: (value: string) => void,
    setUploadMetadataJson: (value: string) => void,
    setUploadTaskId: (value: string) => void
) {
    const candidateTask = tasks.find((task) => task.projectId === projectId);
    setUploadFile(null);
    setUploadTitle("");
    setUploadKind("report");
    setUploadArtifactClass("working_file");
    setUploadImportance("operational");
    setUploadMetadataJson("{}");
    setUploadTaskId(candidateTask?.id ?? "");
}
